package com.teammarhaba.backend.user;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Account lifecycle for the verified caller (TM-112).
 *
 * <p>Accounts are provisioned <strong>just-in-time</strong>: the first authenticated request from
 * a Firebase UID inserts the {@code users} row; later requests reuse it. Identity ({@code uid},
 * {@code email}) is always taken from the verified token — never from client input — so the
 * caller can't claim to be someone else. {@code displayName} starts empty and is the one field
 * the user can edit via {@code PATCH /api/v1/me}.
 *
 * <p>Soft-delete (TM-114): {@link #softDelete} tombstones an account and {@link #restore} brings it
 * back. Because {@code firebase_uid} stays globally unique, a returning user whose account was
 * soft-deleted is <em>reactivated</em> on next sign-in by {@link #provision} rather than duplicated.
 */
@Service
public class UserService {

    /** Audit {@code target_type} for account events. */
    private static final String TARGET_USER = "User";

    /** Properties the admin users list may be sorted on (allow-listed — see {@link PageRequests}). */
    private static final Set<String> SORTABLE = Set.of("id", "email", "displayName", "role", "enabled");

    /** Stable default ordering when the caller requests none. */
    private static final Sort DEFAULT_SORT = Sort.by(Sort.Direction.ASC, "id");

    private final UserRepository users;
    private final AuditService audit;

    public UserService(UserRepository users, AuditService audit) {
        this.users = users;
        this.audit = audit;
    }

    /**
     * Paged, filtered listing of accounts for the admin users console (TM-115) — the first adopter
     * of the {@link PageResponse} list convention. Filters are optional ({@code null} disables a
     * clause); {@code size} is capped and {@code sort} is allow-listed by {@link PageRequests}.
     */
    @Transactional(readOnly = true)
    public PageResponse<UserSummary> list(
            String q, Role role, Boolean enabled, Integer page, Integer size, String sort) {
        Pageable pageable = PageRequests.of(page, size, sort, SORTABLE, DEFAULT_SORT);
        String trimmed = (q == null || q.isBlank()) ? null : q.trim();
        return PageResponse.from(users.search(trimmed, role, enabled, pageable), UserSummary::from);
    }

    /** Find the caller's account, creating (or reactivating) it on first sight. Concurrency-safe. */
    @Transactional
    public User provision(VerifiedUser caller) {
        return users.findByFirebaseUid(caller.uid()).orElseGet(() -> reactivateOrInsert(caller));
    }

    /** Provision-then-update: a PATCH before any GET still works. {@code null} leaves it unchanged. */
    @Transactional
    public User updateDisplayName(VerifiedUser caller, String displayName) {
        User user = provision(caller);
        if (displayName != null) {
            user.setDisplayName(displayName); // dirty-checking flushes on commit
            audit.record(
                    caller.uid(),
                    AuditAction.PROFILE_UPDATED,
                    TARGET_USER,
                    caller.uid(),
                    Map.of("field", "displayName"));
        }
        return user;
    }

    /** Soft-delete an active account: it is then hidden from normal queries but recoverable. */
    @Transactional
    public User softDelete(String firebaseUid) {
        User user = users.findByFirebaseUid(firebaseUid)
                .orElseThrow(() -> new ResourceNotFoundException("No active account for uid " + firebaseUid));
        user.markDeleted(Instant.now()); // dirty-checking flushes on commit
        audit.record(firebaseUid, AuditAction.ACCOUNT_SOFT_DELETED, TARGET_USER, firebaseUid);
        return user;
    }

    /** Restore a soft-deleted account. Idempotent: a no-op if the account is already active. */
    @Transactional
    public User restore(String firebaseUid) {
        User user = users.findAnyByFirebaseUid(firebaseUid)
                .orElseThrow(() -> new ResourceNotFoundException("No account for uid " + firebaseUid));
        boolean wasDeleted = user.isDeleted();
        user.restore();
        if (wasDeleted) { // only an actual restore is auditable; an already-active no-op isn't
            audit.record(firebaseUid, AuditAction.ACCOUNT_RESTORED, TARGET_USER, firebaseUid);
        }
        return user;
    }

    /** No active row: reactivate a soft-deleted tombstone for this uid if one exists, else insert. */
    private User reactivateOrInsert(VerifiedUser caller) {
        return users.findAnyByFirebaseUid(caller.uid())
                .map(tombstone -> {
                    tombstone.restore(); // returning user — bring their account back, don't duplicate
                    audit.record(caller.uid(), AuditAction.ACCOUNT_REACTIVATED, TARGET_USER, caller.uid());
                    return tombstone;
                })
                .orElseGet(() -> insertOrGet(caller));
    }

    private User insertOrGet(VerifiedUser caller) {
        try {
            User created = users.saveAndFlush(new User(caller.uid(), caller.email(), null));
            audit.record(caller.uid(), AuditAction.ACCOUNT_PROVISIONED, TARGET_USER, caller.uid());
            return created;
        } catch (DataIntegrityViolationException race) {
            // A concurrent first-request won the insert (unique firebase_uid) — treat as found.
            // No audit row: the winning request already recorded ACCOUNT_PROVISIONED.
            return users.findByFirebaseUid(caller.uid())
                    .orElseThrow(() -> race); // genuinely absent ⇒ not the race we expected
        }
    }
}
