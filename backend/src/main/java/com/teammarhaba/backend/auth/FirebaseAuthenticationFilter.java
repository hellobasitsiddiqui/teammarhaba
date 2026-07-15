package com.teammarhaba.backend.auth;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseToken;
import com.teammarhaba.backend.user.Role;
import com.teammarhaba.backend.user.UserRepository;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpHeaders;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.util.StringUtils;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Verifies the caller's Firebase ID token on each request (TM-79). Reads
 * {@code Authorization: Bearer <token>}, verifies it with the Firebase Admin SDK, and — on
 * success — establishes the Spring Security context with a {@link VerifiedUser} principal
 * (uid + email) and the authorities derived from the token's {@code role} custom claim
 * ({@link RoleClaims}, TM-110). It never sends a {@code 401} itself: on a missing/invalid token it simply
 * leaves the request unauthenticated, so the security chain's {@link RestAuthenticationEntryPoint}
 * produces one uniform 401 for every protected route (default-deny).
 *
 * <p>{@link FirebaseAuth} is resolved lazily via an {@link ObjectProvider} so it is only
 * initialised when a token is actually present — keeping token-free requests (and the whole
 * dev/test/CI boot, which has no credentials) free of any Firebase initialisation.
 *
 * <p><strong>Account-suspension gate (TM-741/TM-742).</strong> After the token verifies, the filter
 * consults the local {@code users.enabled} flag: an admin "disable/suspend" ({@code enabled = false})
 * must block API access <em>immediately</em>, in the same request. The token check alone can't do this —
 * a token issued before suspension stays valid for its ~1h TTL, and Firebase revocation (best-effort,
 * unavailable without Admin-SDK creds) is a slower defence. So a suspended, active account is refused
 * here (context left empty → the entry point's uniform 401), while an unknown uid still authenticates so
 * just-in-time provisioning (TM-112) keeps working for brand-new users. The lookup is a single indexed
 * existence check, resolved lazily via {@link ObjectProvider} so a slim {@code @WebMvcTest} slice without
 * a repository still builds a working chain (the gate is then simply absent — the full app always has it).
 */
public class FirebaseAuthenticationFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(FirebaseAuthenticationFilter.class);
    private static final String BEARER_PREFIX = "Bearer ";

    private final ObjectProvider<FirebaseAuth> firebaseAuth;
    private final ObjectProvider<UserRepository> users;

    public FirebaseAuthenticationFilter(
            ObjectProvider<FirebaseAuth> firebaseAuth, ObjectProvider<UserRepository> users) {
        this.firebaseAuth = firebaseAuth;
        this.users = users;
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {

        String token = bearerToken(request);
        if (token != null && SecurityContextHolder.getContext().getAuthentication() == null) {
            try {
                // checkRevoked=true also rejects a token whose session was revoked (a demotion,
                // disable, or explicit revokeRefreshTokens) — the fast lockout path — not just an
                // expired/malformed one. A revoked token surfaces as a FirebaseAuthException, caught
                // below like any other verification failure and mapped to the uniform 401.
                FirebaseToken decoded = firebaseAuth.getObject().verifyIdToken(token, true);
                // Suspension gate (TM-741/TM-742): a verified token is necessary but not sufficient —
                // an admin "disable/suspend" flips users.enabled=false, and that must block access in THIS
                // request, not on a slow token-TTL expiry. Refuse a suspended, active account (leave the
                // context empty -> uniform 401). An unknown uid returns false and still authenticates, so
                // just-in-time provisioning (TM-112) of brand-new users is unaffected.
                if (isSuspended(decoded.getUid())) {
                    SecurityContextHolder.clearContext();
                    log.debug("Rejected request from suspended account uid={}", decoded.getUid());
                    chain.doFilter(request, response);
                    return;
                }
                VerifiedUser user = new VerifiedUser(decoded.getUid(), decoded.getEmail());
                // Map the `role` custom claim -> a ROLE_* authority (TM-110); fail-safe to USER.
                Role role = RoleClaims.roleFrom(decoded.getClaims());
                var authentication = new UsernamePasswordAuthenticationToken(
                        user, null, RoleClaims.authorities(role));
                authentication.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
                SecurityContextHolder.getContext().setAuthentication(authentication);
            } catch (Exception e) {
                // Invalid/expired token (or no Firebase credentials): leave unauthenticated so
                // the entry point returns a uniform 401. Never log the token itself.
                SecurityContextHolder.clearContext();
                log.debug("Firebase ID token verification failed: {}", e.getMessage());
            }
        }
        chain.doFilter(request, response);
    }

    /**
     * True iff this uid maps to an active, suspended account ({@code enabled = false}) — the inbound
     * enforcement of an admin disable/suspend (TM-741/TM-742). An unknown uid is {@code false} so
     * just-in-time provisioning (TM-112) still authenticates a brand-new user. When no
     * {@link UserRepository} bean is wired (a slim {@code @WebMvcTest} slice), the gate is absent and
     * defaults to {@code false}; the full application context always supplies the repository.
     */
    private boolean isSuspended(String uid) {
        UserRepository repo = users.getIfAvailable();
        return repo != null && repo.existsByFirebaseUidAndEnabledFalse(uid);
    }

    private String bearerToken(HttpServletRequest request) {
        String header = request.getHeader(HttpHeaders.AUTHORIZATION);
        if (StringUtils.hasText(header) && header.startsWith(BEARER_PREFIX)) {
            String token = header.substring(BEARER_PREFIX.length()).trim();
            return token.isEmpty() ? null : token;
        }
        return null;
    }
}
