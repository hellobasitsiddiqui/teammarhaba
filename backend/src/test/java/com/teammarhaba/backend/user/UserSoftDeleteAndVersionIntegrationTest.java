package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditEvent;
import com.teammarhaba.backend.audit.AuditRepository;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.membership.MembershipTier;
import com.teammarhaba.backend.membership.Subscription;
import com.teammarhaba.backend.membership.SubscriptionRepository;
import com.teammarhaba.backend.membership.SubscriptionStatus;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.orm.ObjectOptimisticLockingFailureException;

/**
 * Verifies the TM-114 data conventions on the {@code users} entity: soft-delete hides rows from
 * normal queries while keeping them restorable, a returning user is reactivated (not duplicated),
 * and a stale concurrent write fails the optimistic-lock check instead of silently overwriting.
 */
class UserSoftDeleteAndVersionIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private UserRepository users;

    @Autowired
    private UserService userService;

    @Autowired
    private SubscriptionRepository subscriptions;

    @Autowired
    private AuditRepository audit;

    private static VerifiedUser caller(String uid, String email) {
        return new VerifiedUser(uid, email);
    }

    @Test
    void softDeleteHidesFromNormalQueriesAndRestoreBringsItBack() {
        userService.provision(caller("uid-sd", "sd@example.com"));
        assertThat(users.findByFirebaseUid("uid-sd")).isPresent();

        userService.softDelete("uid-sd");

        // Excluded from every normal query by the entity's @SQLRestriction...
        assertThat(users.findByFirebaseUid("uid-sd")).isEmpty();
        assertThat(users.findAll()).noneMatch(u -> "uid-sd".equals(u.getFirebaseUid()));
        // ...but the tombstone still exists and is reachable for restore.
        assertThat(users.findAnyByFirebaseUid("uid-sd")).hasValueSatisfying(u -> {
            assertThat(u.isDeleted()).isTrue();
            assertThat(u.getDeletedAt()).isNotNull();
        });

        User restored = userService.restore("uid-sd");
        assertThat(restored.isDeleted()).isFalse();
        assertThat(restored.getDeletedAt()).isNull();
        assertThat(users.findByFirebaseUid("uid-sd")).isPresent();
    }

    @Test
    void softDeleteLapsesTheAccountsSubscriptionSoNoRenewalCanCharge() {
        // TM-623: tombstoning the account used to leave its subscription live — nextChargeAt kept the
        // renewal engine charging the deleted account's saved card every cycle. The soft delete now
        // lapses the subscription in the same transaction: CANCELED, nothing scheduled, ever.
        User user = userService.provision(caller("uid-sd-sub", "sd-sub@example.com"));
        Subscription subscription = subscriptions.save(
                new Subscription(user.getId(), MembershipTier.MONTHLY, "revolut", "cust-sd-1", Instant.now()));
        assertThat(subscription.getNextChargeAt()).isNotNull(); // a renewal is scheduled

        userService.softDelete("uid-sd-sub");

        Subscription lapsed = subscriptions.findById(subscription.getId()).orElseThrow();
        assertThat(lapsed.getStatus()).isEqualTo(SubscriptionStatus.CANCELED);
        assertThat(lapsed.getNextChargeAt()).isNull(); // unscheduled — the due scan never sees it again
        assertThat(lapsed.getCanceledAt()).isNotNull();
    }

    @Test
    void dueScanExcludesSubscriptionsOfSoftDeletedAccounts() {
        // TM-623 belt-and-braces for rows tombstoned BEFORE the lapse-on-delete fix existed: even a
        // still-scheduled subscription must not enter the renewal pass once its account is deleted.
        User active = userService.provision(caller("uid-scan-a", "scan-a@example.com"));
        User doomed = userService.provision(caller("uid-scan-d", "scan-d@example.com"));
        Instant subscribed = Instant.now().minus(java.time.Duration.ofDays(35)); // due ~5 days ago
        Subscription dueActive = subscriptions.save(
                new Subscription(active.getId(), MembershipTier.MONTHLY, "revolut", "cust-scan-a", subscribed));
        Subscription dueDoomed = subscriptions.save(
                new Subscription(doomed.getId(), MembershipTier.MONTHLY, "revolut", "cust-scan-d", subscribed));

        // Tombstone WITHOUT the service (which would lapse the subscription) — the legacy shape.
        doomed.markDeleted(Instant.now());
        users.save(doomed);

        var due = subscriptions.findDueForActiveUsers(
                Instant.now(), org.springframework.data.domain.PageRequest.of(0, 100));

        assertThat(due).extracting(Subscription::getId).contains(dueActive.getId());
        assertThat(due).extracting(Subscription::getId).doesNotContain(dueDoomed.getId());
    }

    @Test
    void reLoginReactivatesASoftDeletedAccountInsteadOfDuplicating() {
        User first = userService.provision(caller("uid-re", "re@example.com"));
        userService.softDelete("uid-re");
        assertThat(users.findByFirebaseUid("uid-re")).isEmpty();

        User second = userService.provision(caller("uid-re", "re@example.com"));

        assertThat(second.getId()).isEqualTo(first.getId()); // same row reactivated, not a duplicate
        assertThat(second.isDeleted()).isFalse();
    }

    @Test
    void provision_reactivatesSoftDeletedAccountOnNextSignInNotDuplicate() {
        // TM-738 P1 (auth): a returning user whose account was soft-deleted must be REACTIVATED on their
        // next sign-in (provision runs on every authenticated request), never a second row inserted.
        // Stronger than the sibling above: this pins BOTH invariants the reactivate path guarantees —
        // (1) exactly ONE users row ever exists for the uid across the whole delete→re-auth cycle (the
        // firebase_uid unique key would otherwise be an integrity breach), and (2) the audit trail records
        // the DISTINCT reactivate action (ACCOUNT_REACTIVATED), not a fresh ACCOUNT_PROVISIONED — which is
        // exactly how a "returning user reactivated" is told apart from "brand-new user created".
        String uid = "uid-reactivate-audit";
        User first = userService.provision(caller(uid, "reactivate@example.com")); // first sight -> INSERT
        userService.softDelete(uid); // tombstone
        assertThat(users.findByFirebaseUid(uid)).isEmpty(); // hidden from normal queries

        User reAuthed = userService.provision(caller(uid, "reactivate@example.com")); // returns -> reactivate

        // Same row brought back, not a duplicate...
        assertThat(reAuthed.getId()).isEqualTo(first.getId());
        assertThat(reAuthed.isDeleted()).isFalse();
        assertThat(reAuthed.getDeletedAt()).isNull();
        // ...and there is exactly ONE row for this uid across ALL rows (including any tombstoned ones),
        // proving re-auth reactivated rather than inserting a second account.
        assertThat(users.findAll().stream().filter(u -> uid.equals(u.getFirebaseUid())).count())
                .isEqualTo(1L);

        // The audit trail names the reactivate distinctly: newest-first it is REACTIVATED, then
        // SOFT_DELETED, then the original PROVISIONED — a returning user, NOT a re-created one (which
        // would show a second ACCOUNT_PROVISIONED instead).
        List<AuditEvent> history = audit.findByTargetTypeAndTargetIdOrderByCreatedAtDesc("User", uid);
        assertThat(history).extracting(AuditEvent::getAction)
                .containsExactly(
                        AuditAction.ACCOUNT_REACTIVATED,
                        AuditAction.ACCOUNT_SOFT_DELETED,
                        AuditAction.ACCOUNT_PROVISIONED);
    }

    @Test
    void provision_suspendedThenReAuth_doesNotSilentlyReEnable() {
        // TM-738 P0 (auth): a suspended account (admin set enabled=false, TM-111) must NOT be silently
        // switched back on just because the user signs in again. `provision` is reached on every
        // authenticated request (just-in-time provisioning); its reactivate path only ever touches the
        // *soft-delete* tombstone (deletedAt) — the `enabled` suspension flag is a DISTINCT lifecycle
        // (see User's javadoc) and must be left exactly as the admin set it. If provision regressed to
        // re-enable on re-auth, a suspended user could reinstate themselves simply by re-authenticating.
        User provisioned = userService.provision(caller("uid-susp", "susp@example.com"));
        assertThat(provisioned.isEnabled()).isTrue(); // accounts start enabled

        // Suspend the account the way the admin path does (UserAdminService.update -> user.setEnabled),
        // persisted so the re-provision below reads it back from the DB, not a stale in-memory copy.
        provisioned.setEnabled(false);
        users.saveAndFlush(provisioned);
        assertThat(users.findByFirebaseUid("uid-susp").orElseThrow().isEnabled()).isFalse();

        // Re-authenticate: same uid provisions again (the account was never soft-deleted, so this is the
        // plain "row exists" read path — no reactivate).
        User reAuthed = userService.provision(caller("uid-susp", "susp@example.com"));

        // Still the same row, and STILL suspended — provision never re-enabled it.
        assertThat(reAuthed.getId()).isEqualTo(provisioned.getId());
        assertThat(reAuthed.isEnabled()).isFalse();
        assertThat(users.findByFirebaseUid("uid-susp").orElseThrow().isEnabled()).isFalse();
    }

    @Test
    void staleUpdateFailsWithOptimisticLockConflict() {
        userService.provision(caller("uid-ol", "ol@example.com"));

        // Two independent loads (each in its own transaction) ⇒ two detached copies at the same version.
        User stale = users.findByFirebaseUid("uid-ol").orElseThrow();
        User fresh = users.findByFirebaseUid("uid-ol").orElseThrow();

        fresh.setDisplayName("first writer wins");
        users.saveAndFlush(fresh); // version 0 -> 1

        User reloaded = users.findByFirebaseUid("uid-ol").orElseThrow();
        assertThat(reloaded.getVersion()).isGreaterThan(stale.getVersion());

        stale.setDisplayName("second writer is stale");
        assertThatThrownBy(() -> users.saveAndFlush(stale))
                .isInstanceOf(ObjectOptimisticLockingFailureException.class);
    }
}
