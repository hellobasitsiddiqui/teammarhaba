package com.teammarhaba.backend.auth;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseAuthException;
import com.teammarhaba.backend.user.Role;
import com.teammarhaba.backend.user.UserService;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/**
 * Writes a user's {@code role} as a Firebase custom claim via the Admin SDK (TM-110) — the
 * single, guarded seam for changing a role. The admin user-management endpoints (TM-111) and the
 * first-admin bootstrap ({@link AdminBootstrap}) call this; it is intentionally not exposed on the
 * web layer here.
 *
 * <p>The claim is the source of truth for authorization (see {@link RoleClaims}). Two consequences
 * worth knowing: (1) {@code setCustomUserClaims} <em>replaces</em> the user's whole custom-claims
 * object — {@code role} is the only claim today, so a plain replace is correct; (2) a change only
 * reaches the client after its ID token refreshes (on the next hourly refresh, or a forced refresh),
 * because existing tokens keep the old claim until then.
 *
 * <p>{@link FirebaseAuth} is resolved lazily through an {@link ObjectProvider} so that — like the
 * verification path — nothing here touches Firebase/ADC until a role is actually assigned, keeping
 * dev/test/CI boots credential-free.
 */
@Service
public class RoleService {

    private static final Logger log = LoggerFactory.getLogger(RoleService.class);

    private final ObjectProvider<FirebaseAuth> firebaseAuth;
    private final UserService userService;

    public RoleService(ObjectProvider<FirebaseAuth> firebaseAuth, UserService userService) {
        this.firebaseAuth = firebaseAuth;
        this.userService = userService;
    }

    /**
     * Assign {@code role} to the account identified by {@code uid}: write the {@code role} custom
     * claim (the authorization source of truth) <em>and</em> mirror it onto the {@code users} row, so
     * {@code GET /api/v1/me} reflects it (TM-140 — previously only the claim was written, leaving
     * {@code /me} showing a stale {@code USER}). The claim is written first; if it fails, the row is
     * left untouched. Idempotent — re-assigning the same role is a no-op in effect.
     *
     * @throws FirebaseAuthException if the user does not exist or the Admin SDK call fails
     */
    public void assignRole(String uid, Role role) throws FirebaseAuthException {
        firebaseAuth.getObject().setCustomUserClaims(uid, Map.of(RoleClaims.CLAIM, role.name()));
        userService.syncRole(uid, role);
        log.info("Assigned role {} to uid {} (claim + DB row; effective on the user's next token refresh).", role, uid);
    }
}
