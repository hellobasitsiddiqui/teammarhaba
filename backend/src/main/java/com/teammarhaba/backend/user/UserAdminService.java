package com.teammarhaba.backend.user;

import com.google.firebase.auth.FirebaseAuthException;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.RoleService;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import com.teammarhaba.backend.web.SelfActionNotAllowedException;
import java.util.Map;
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
 * </ul>
 */
@Service
public class UserAdminService {

    /** Audit {@code target_type} for account actions — the kind of thing acted on. */
    private static final String TARGET_TYPE = "User";

    private final UserRepository users;
    private final RoleService roleService;
    private final AuditService audit;

    public UserAdminService(UserRepository users, RoleService roleService, AuditService audit) {
        this.users = users;
        this.roleService = roleService;
        this.audit = audit;
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
            user.setEnabled(enabled);
            audit.record(
                    callerUid,
                    AuditAction.ACCOUNT_ENABLED_CHANGED,
                    TARGET_TYPE,
                    String.valueOf(id),
                    Map.of("enabled", enabled));
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

    private static ResourceNotFoundException notFound() {
        return new ResourceNotFoundException("User not found.");
    }
}
