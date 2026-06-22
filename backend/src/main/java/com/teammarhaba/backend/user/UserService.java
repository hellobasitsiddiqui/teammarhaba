package com.teammarhaba.backend.user;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Instant;
import org.springframework.dao.DataIntegrityViolationException;
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

    private final UserRepository users;

    public UserService(UserRepository users) {
        this.users = users;
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
        }
        return user;
    }

    /** Soft-delete an active account: it is then hidden from normal queries but recoverable. */
    @Transactional
    public User softDelete(String firebaseUid) {
        User user = users.findByFirebaseUid(firebaseUid)
                .orElseThrow(() -> new ResourceNotFoundException("No active account for uid " + firebaseUid));
        user.markDeleted(Instant.now()); // dirty-checking flushes on commit
        return user;
    }

    /** Restore a soft-deleted account. Idempotent: a no-op if the account is already active. */
    @Transactional
    public User restore(String firebaseUid) {
        User user = users.findAnyByFirebaseUid(firebaseUid)
                .orElseThrow(() -> new ResourceNotFoundException("No account for uid " + firebaseUid));
        user.restore();
        return user;
    }

    /** No active row: reactivate a soft-deleted tombstone for this uid if one exists, else insert. */
    private User reactivateOrInsert(VerifiedUser caller) {
        return users.findAnyByFirebaseUid(caller.uid())
                .map(tombstone -> {
                    tombstone.restore(); // returning user — bring their account back, don't duplicate
                    return tombstone;
                })
                .orElseGet(() -> insertOrGet(caller));
    }

    private User insertOrGet(VerifiedUser caller) {
        try {
            return users.saveAndFlush(new User(caller.uid(), caller.email(), null));
        } catch (DataIntegrityViolationException race) {
            // A concurrent first-request won the insert (unique firebase_uid) — treat as found.
            return users.findByFirebaseUid(caller.uid())
                    .orElseThrow(() -> race); // genuinely absent ⇒ not the race we expected
        }
    }
}
