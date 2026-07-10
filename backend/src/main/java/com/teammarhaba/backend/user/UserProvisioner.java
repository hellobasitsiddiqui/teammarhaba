package com.teammarhaba.backend.user;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * The <em>writable</em> half of just-in-time account provisioning (TM-597).
 *
 * <p>{@link UserService#provision} is reached from both write endpoints and — crucially — from
 * <strong>read-only</strong> {@code /me}-surface reads (chat lists, notification feeds, event
 * queries), each annotated {@code @Transactional(readOnly = true)}. With Spring's default
 * {@code REQUIRED} propagation, a naive {@code @Transactional} on {@code provision} simply
 * <em>joins</em> that read-only outer transaction, so a first-sight INSERT blows up with
 * "cannot execute INSERT in a read-only transaction". On top of that, a first-request burst from a
 * single new user (many parallel {@code /me} calls) races: two callers both see "no row" and both
 * INSERT, tripping the {@code users_firebase_uid_key} unique constraint.
 *
 * <p>This bean isolates the create/reactivate write in its <strong>own</strong>
 * {@link Propagation#REQUIRES_NEW} transaction. Because it is a separate Spring bean, the call from
 * {@code UserService} crosses a real proxy boundary (a self-invocation would silently skip the
 * new-transaction advice), so the write always runs in a fresh, <em>writable</em> transaction —
 * regardless of a read-only caller — and commits (or cleanly rolls back) independently of it.
 *
 * <p>The unique-violation race is handled where it belongs: the losing INSERT throws
 * {@link DataIntegrityViolationException}, which rolls back <em>only</em> this inner transaction
 * (never poisoning the caller's), and {@code UserService} then simply re-reads the winner's now
 * committed row. Net effect: exactly one row is ever created and every concurrent caller returns it.
 */
@Service
class UserProvisioner {

    /** Audit {@code target_type} for account events — mirrors {@link UserService}. */
    private static final String TARGET_USER = "User";

    private final UserRepository users;
    private final AuditService audit;

    UserProvisioner(UserRepository users, AuditService audit) {
        this.users = users;
        this.audit = audit;
    }

    /**
     * Create the caller's {@code users} row — or reactivate their soft-deleted tombstone — in a
     * dedicated writable transaction. Only ever invoked once {@link UserService#provision} has already
     * failed to find an active row, so the common (row-exists) path never pays for the extra
     * transaction.
     *
     * <p>Runs in a brand-new transaction ({@link Propagation#REQUIRES_NEW}) so it neither inherits a
     * read-only caller transaction nor, on the unique-violation race, drags the caller's transaction
     * into rollback. A {@code null} display name is the deliberate starting state (the one field the
     * user later edits). The unique-{@code firebase_uid} INSERT is what serialises concurrent first
     * requests: the winner commits here, the loser gets a {@link DataIntegrityViolationException}
     * (this transaction rolls back) and {@code UserService} re-reads the winner's row.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public User createOrReactivate(VerifiedUser caller) {
        return users.findAnyByFirebaseUid(caller.uid())
                .map(existing -> reactivate(existing, caller))
                .orElseGet(() -> insert(caller));
    }

    /**
     * A row already exists for this uid. If it is a soft-deleted tombstone, bring it back (a returning
     * user is reactivated, never duplicated) and audit it. If it is already active — a concurrent
     * creator committed between {@code provision}'s read and this lookup — reuse it untouched (no
     * spurious {@code ACCOUNT_REACTIVATED} for an account that was never actually deleted).
     */
    private User reactivate(User existing, VerifiedUser caller) {
        if (existing.isDeleted()) {
            existing.restore();
            audit.record(caller.uid(), AuditAction.ACCOUNT_REACTIVATED, TARGET_USER, caller.uid());
        }
        return existing;
    }

    /**
     * Insert a fresh account. {@code saveAndFlush} forces the INSERT to hit the DB now, so a losing
     * concurrent creator surfaces its unique-violation here (before the audit row is written) rather
     * than at some later, harder-to-attribute flush. Only the winning insert records
     * {@code ACCOUNT_PROVISIONED}.
     */
    private User insert(VerifiedUser caller) {
        User created = users.saveAndFlush(new User(caller.uid(), caller.email(), null));
        audit.record(caller.uid(), AuditAction.ACCOUNT_PROVISIONED, TARGET_USER, caller.uid());
        return created;
    }
}
