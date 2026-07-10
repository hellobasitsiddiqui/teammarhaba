package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.membership.MembershipTier;
import com.teammarhaba.backend.membership.Subscription;
import com.teammarhaba.backend.membership.SubscriptionRepository;
import com.teammarhaba.backend.membership.SubscriptionStatus;
import java.time.Instant;
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
