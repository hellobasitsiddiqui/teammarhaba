package com.teammarhaba.backend.auth;

import com.google.firebase.auth.FirebaseAuth;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/**
 * "Sign out everywhere" for the caller themselves (TM-924) — revoke <em>all</em> of a user's Firebase
 * refresh tokens so every already-issued ID token stops verifying on its next request.
 *
 * <p>This reuses the exact primitive the admin demotion path already relies on
 * ({@code FirebaseAuth.revokeRefreshTokens(uid)} — see {@code UserAdminService.revokeSessions}). It is
 * <strong>not</strong> a per-session revoke: Firebase has no per-session granularity, so this boots
 * every session the account holds, including the one that made the request. That is exactly the
 * recover-from-a-lost/shared-device story the UI offers; per-device sign-out (which needs a real
 * session registry) is deliberately deferred to TM-1077 and is <em>not</em> built here.
 *
 * <p>The enforcement half is already live: {@code FirebaseAuthenticationFilter} verifies tokens with
 * {@code checkRevoked=true}, so a revoked user is refused with the uniform {@code 401} on their very
 * next request — this service only has to <em>trigger</em> the revoke.
 *
 * <p><b>Degrade-quietly, like the admin path.</b> {@link FirebaseAuth} is resolved lazily through an
 * {@link ObjectProvider}: in dev/test/CI there is no Admin SDK bean (no credentials), so
 * {@code getIfAvailable()} returns {@code null} or throws on creation. Both mean "can't revoke"; we
 * log and return {@code false} rather than 500 the endpoint, matching
 * {@code UserAdminService.revokeSessions}. In production the bean is present and the revoke is real.
 */
@Service
public class SessionRevocationService {

    private static final Logger log = LoggerFactory.getLogger(SessionRevocationService.class);

    /** Audit {@code target_type} — the account is the thing acted on (it revokes itself). */
    private static final String TARGET_USER = "User";

    private final ObjectProvider<FirebaseAuth> firebaseAuth;
    private final AuditService audit;

    public SessionRevocationService(ObjectProvider<FirebaseAuth> firebaseAuth, AuditService audit) {
        this.firebaseAuth = firebaseAuth;
        this.audit = audit;
    }

    /**
     * Revoke every refresh token for {@code firebaseUid}, signing the account out of all sessions
     * (TM-924). Records one {@link AuditAction#SESSIONS_REVOKED_ALL} row on an actual revoke.
     * Best-effort: if the Admin SDK is unavailable (dev/test/CI) or the revoke call fails, the failure
     * is logged and swallowed and {@code false} is returned — the endpoint still answers {@code 2xx}
     * rather than surfacing an infrastructure gap to the caller, since a failed revoke leaves the
     * account no worse off than before it asked.
     *
     * @param firebaseUid the caller's own Firebase uid (from the verified token, never the client body)
     * @return {@code true} if the revoke was actually issued to Firebase; {@code false} if it degraded
     */
    public boolean signOutEverywhere(String firebaseUid) {
        FirebaseAuth auth;
        try {
            // getIfAvailable() returns null when no bean is defined; when the lazy definition exists but
            // creation fails (no ADC in CI) it THROWS — both mean "can't revoke", degrade quietly.
            auth = firebaseAuth.getIfAvailable();
        } catch (Exception ex) {
            log.warn("FirebaseAuth unavailable — could not sign user {} out everywhere.", firebaseUid, ex);
            return false;
        }
        if (auth == null) {
            log.warn("No FirebaseAuth bean — sign-out-everywhere for user {} degraded to a no-op.", firebaseUid);
            return false;
        }
        try {
            auth.revokeRefreshTokens(firebaseUid);
            audit.record(firebaseUid, AuditAction.SESSIONS_REVOKED_ALL, TARGET_USER, firebaseUid);
            log.info("Signed user {} out everywhere — all refresh tokens revoked; sessions boot on next request.", firebaseUid);
            return true;
        } catch (Exception ex) {
            log.warn("Could not sign user {} out everywhere — refresh-token revoke failed.", firebaseUid, ex);
            return false;
        }
    }
}
