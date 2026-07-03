package com.teammarhaba.backend.user;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseAuthException;
import com.google.firebase.auth.GetUsersResult;
import com.google.firebase.auth.UidIdentifier;
import com.google.firebase.auth.UserIdentifier;
import com.google.firebase.auth.UserRecord;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.RoleService;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushNotificationService;
import com.teammarhaba.backend.notify.PushRoutes;
import com.teammarhaba.backend.web.BadRequestException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import com.teammarhaba.backend.web.SelfActionNotAllowedException;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Admin-only account management (TM-111): list accounts, and enable/disable or change the role of a
 * single account. Authorization (ADMIN-only) is enforced at the web layer ({@code @PreAuthorize});
 * this service owns the <em>rules</em>:
 *
 * <ul>
 *   <li><b>404, not 403, for a missing target</b> — an unknown (or soft-deleted) id is a
 *       {@link ResourceNotFoundException} so the API never reveals whether an id exists.</li>
 *   <li><b>Admin self-protection</b> — an admin cannot disable or change the role of their own
 *       account ({@link SelfActionNotAllowedException} → 422), so they can't lock themselves out.</li>
 *   <li><b>Role = Firebase claim first, row second</b> — a role change writes the custom claim (the
 *       authorization source of truth, via {@link RoleService}) and then mirrors it onto the row, so
 *       a claim-write failure rolls the transaction back rather than leaving the two out of sync.</li>
 *   <li><b>Audited</b> — every effective enable/disable or role change appends one immutable audit
 *       event (TM-137) in the same transaction as the change, so it's never silently un-audited.</li>
 *   <li><b>Auth-phone enrichment (TM-372)</b> — {@link #authPhonesByUid} reads the verified auth
 *       phone numbers live from Firebase (batched, best-effort, never stored) so the console can
 *       identify phone-auth accounts that have no email/display name instead of showing blank rows.</li>
 * </ul>
 */
@Service
public class UserAdminService {

    private static final Logger log = LoggerFactory.getLogger(UserAdminService.class);

    /** Audit {@code target_type} for account actions — the kind of thing acted on. */
    private static final String TARGET_TYPE = "User";

    /** The Admin SDK's cap on identifiers per {@code getUsers} batch lookup. */
    private static final int FIREBASE_LOOKUP_BATCH = 100;

    private final UserRepository users;
    private final RoleService roleService;
    private final AuditService audit;
    private final PushNotificationService push;
    private final ObjectProvider<FirebaseAuth> firebaseAuth;

    public UserAdminService(
            UserRepository users,
            RoleService roleService,
            AuditService audit,
            PushNotificationService push,
            ObjectProvider<FirebaseAuth> firebaseAuth) {
        this.users = users;
        this.roleService = roleService;
        this.audit = audit;
        this.push = push;
        // Lazily resolved, like FirebaseAccountStateService — no Admin SDK bean (dev/test/CI without
        // credentials) must not stop this service from constructing or the console from listing.
        this.firebaseAuth = firebaseAuth;
    }

    /** A page of active accounts. Soft-deleted rows are excluded by the entity's {@code @SQLRestriction}. */
    @Transactional(readOnly = true)
    public Page<User> list(Pageable pageable) {
        return users.findAll(pageable);
    }

    /** A single active account by id, or {@code 404} (no existence leak) if absent/soft-deleted. */
    @Transactional(readOnly = true)
    public User get(long id) {
        return users.findById(id).orElseThrow(UserAdminService::notFound);
    }

    /**
     * The verified auth phone numbers for {@code firebaseUids}, keyed by uid, read <strong>live</strong>
     * from Firebase (TM-372). A phone-auth account often has no email and no display name, so without
     * this the admin console renders it as a blank, unfindable row; the auth phone is the identifier
     * that makes it manageable. We never store it — Firebase stays the source of truth for auth
     * identity, the same rule {@link com.teammarhaba.backend.auth.FirebaseAccountStateService} follows.
     * (The user-editable profile {@code phone} column is a different, unrelated field.)
     *
     * <p><strong>Cost:</strong> one batched Admin-SDK {@code getUsers} round trip per
     * {@value #FIREBASE_LOOKUP_BATCH} accounts — a single call for a full admin page (the page size
     * cap equals the SDK's batch cap).
     *
     * <p><strong>Best-effort by design:</strong> no Admin SDK bean (dev/test/CI without credentials),
     * an SDK failure, an unknown uid, or an account with no phone identity all just leave entries out
     * of the map — never an exception, so an identity-provider blip degrades the console's phone
     * column instead of 500-ing the user list. Callers treat a missing key as "unknown".
     */
    public Map<String, String> authPhonesByUid(Collection<String> firebaseUids) {
        if (firebaseUids == null || firebaseUids.isEmpty()) {
            return Map.of();
        }
        FirebaseAuth auth;
        try {
            // getIfAvailable() returns null only when NO bean definition exists; when the lazy
            // definition exists but creation fails (e.g. no ADC in CI), it THROWS — same trap
            // FirebaseAccountStateService guards. Degrade to "no enrichment", never a 500.
            auth = firebaseAuth.getIfAvailable();
        } catch (Exception ex) {
            log.warn("FirebaseAuth unavailable for auth-phone enrichment — rows fall back to their id.", ex);
            return Map.of();
        }
        if (auth == null) {
            return Map.of();
        }
        List<UserIdentifier> identifiers = firebaseUids.stream()
                .filter(Objects::nonNull)
                .distinct()
                .map(uid -> (UserIdentifier) new UidIdentifier(uid))
                .toList();
        Map<String, String> phones = new HashMap<>();
        for (int i = 0; i < identifiers.size(); i += FIREBASE_LOOKUP_BATCH) {
            List<UserIdentifier> chunk =
                    identifiers.subList(i, Math.min(i + FIREBASE_LOOKUP_BATCH, identifiers.size()));
            try {
                GetUsersResult result = auth.getUsers(chunk);
                if (result == null) {
                    continue; // defensive: an unstubbed test double — treat as "nothing found"
                }
                for (UserRecord record : result.getUsers()) {
                    if (record.getPhoneNumber() != null) {
                        phones.put(record.getUid(), record.getPhoneNumber());
                    }
                }
            } catch (Exception ex) {
                // Degrade, don't fail the console: affected rows fall back to their DB id in the UI.
                log.warn(
                        "Could not read auth phone numbers from Firebase for {} account(s) — those rows "
                                + "will fall back to their id.",
                        chunk.size(),
                        ex);
            }
        }
        return phones;
    }

    /** Single-account variant of {@link #authPhonesByUid} (get/PATCH responses); null when unknown. */
    public String authPhoneFor(String firebaseUid) {
        return firebaseUid == null ? null : authPhonesByUid(List.of(firebaseUid)).get(firebaseUid);
    }

    /**
     * Apply a partial update (enable/disable and/or role) to the account {@code id}, on behalf of the
     * admin identified by {@code callerUid}. Enforces self-protection and keeps the role claim and row
     * in step. Returns the updated account.
     */
    @Transactional
    public User update(long id, Boolean enabled, Role role, String callerUid) {
        User user = users.findById(id).orElseThrow(UserAdminService::notFound);
        boolean isSelf = user.getFirebaseUid().equals(callerUid);

        if (enabled != null && !enabled && isSelf) {
            throw new SelfActionNotAllowedException("You cannot disable your own account.");
        }
        if (role != null && role != user.getRole() && isSelf) {
            throw new SelfActionNotAllowedException("You cannot change your own role.");
        }

        // Only an *effective* change is applied and audited — a no-op request writes no event.
        if (enabled != null && enabled != user.isEnabled()) {
            boolean reEnabled = enabled; // false→true: the account is being switched back on
            user.setEnabled(enabled);
            audit.record(
                    callerUid,
                    AuditAction.ACCOUNT_ENABLED_CHANGED,
                    TARGET_TYPE,
                    String.valueOf(id),
                    Map.of("enabled", enabled));
            if (reEnabled) {
                notifyAccountReEnabled(user);
            }
        }
        if (role != null && role != user.getRole()) {
            Role previous = user.getRole();
            // Claim is the source of truth — write it first; the row is the mirror.
            try {
                roleService.assignRole(user.getFirebaseUid(), role);
            } catch (FirebaseAuthException e) {
                throw new IllegalStateException("Failed to update the role claim for user " + id, e);
            }
            user.setRole(role); // dirty-checking flushes on commit
            audit.record(
                    callerUid,
                    AuditAction.ROLE_CHANGED,
                    TARGET_TYPE,
                    String.valueOf(id),
                    Map.of("from", previous.name(), "to", role.name()));
        }
        return user;
    }

    /**
     * The real send-push trigger (TM-284): when an admin re-enables an account, notify that user's
     * devices. It runs behind the {@link PushNotificationService} seam and is best-effort — a push
     * problem must never fail or roll back the admin action that actually changed the account state,
     * so any error here is swallowed (the service itself already prunes dead tokens and logs failures).
     */
    private void notifyAccountReEnabled(User user) {
        try {
            push.sendToUser(
                    user.getId(),
                    new PushMessage(
                            "Your TeamMarhaba account is active again",
                            "An admin has re-enabled your account. Welcome back!",
                            // TM-290: deep-link the tap to the user's own profile — the natural landing
                            // spot after a re-enable. A known route from PushRoutes.KNOWN.
                            "#/profile"));
        } catch (RuntimeException e) {
            log.warn("Re-enable push for user {} failed (account change still applied).", user.getId(), e);
        }
    }

    /**
     * Manual/test send-push trigger (TM-284): deliver a fixed test notification to an account's devices,
     * so an admin/operator can verify the end-to-end push path against a real device without waiting for
     * an organic event. Validates the target exists (404 / no existence leak) and returns the fan-out
     * summary (how many devices were targeted, delivered, pruned, failed). Unlike the re-enable trigger
     * this surfaces send problems to the caller, since it exists precisely to exercise delivery.
     *
     * <p>An optional {@code route} (TM-290) lets the operator exercise the deep-link path too: when
     * supplied it is set on the message's {@code data.route} so a tap navigates there. It must be one of
     * the app's known hash routes ({@link PushRoutes#KNOWN}); an unknown route is a {@code 400}
     * ({@link BadRequestException}) rather than emitting an off-list route. A {@code null} route sends a
     * plain notification (no deep-link), as before.
     */
    @Transactional(readOnly = true)
    public PushNotificationService.PushFanout sendTestPush(long id, String route) {
        if (route != null && !PushRoutes.isKnown(route)) {
            throw new BadRequestException(
                    "Unknown push route '" + route + "'. Allowed: " + PushRoutes.KNOWN);
        }
        User user = users.findById(id).orElseThrow(UserAdminService::notFound);
        return push.sendToUser(
                user.getId(),
                new PushMessage(
                        "TeamMarhaba test notification", "If you can see this, push is working.", route));
    }

    private static ResourceNotFoundException notFound() {
        return new ResourceNotFoundException("User not found.");
    }
}
