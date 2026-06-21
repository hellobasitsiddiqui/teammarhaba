package com.teammarhaba.backend.user;

import com.teammarhaba.backend.auth.VerifiedUser;
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
 */
@Service
public class UserService {

    private final UserRepository users;

    public UserService(UserRepository users) {
        this.users = users;
    }

    /** Find the caller's account, creating it on first sight. Idempotent under concurrency. */
    @Transactional
    public User provision(VerifiedUser caller) {
        return users.findByFirebaseUid(caller.uid()).orElseGet(() -> insertOrGet(caller));
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
