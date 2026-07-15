package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseAuthException;
import com.google.firebase.auth.FirebaseToken;
import com.teammarhaba.backend.user.UserRepository;
import jakarta.servlet.FilterChain;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * Unit test for the {@code role} custom claim → {@code ROLE_*} authority mapping the filter applies
 * (TM-110). A token with {@code role=ADMIN} yields {@code ROLE_ADMIN}; absent/unknown fails safe to
 * {@code ROLE_USER}. The token-verification + 401 behaviour is covered by the integration test.
 */
class FirebaseAuthenticationFilterTest {

    @AfterEach
    void clearContext() {
        SecurityContextHolder.clearContext();
    }

    private Authentication authenticateWithClaims(Map<String, Object> claims) throws Exception {
        FirebaseToken token = mock(FirebaseToken.class);
        when(token.getUid()).thenReturn("uid-1");
        when(token.getEmail()).thenReturn("user@example.com");
        when(token.getClaims()).thenReturn(claims);

        FirebaseAuth auth = mock(FirebaseAuth.class);
        // The filter verifies with checkRevoked=true (TM-723), so stub the two-arg overload.
        when(auth.verifyIdToken("good-token", true)).thenReturn(token);

        return authenticateWith(auth, "good-token");
    }

    private Authentication authenticateWith(FirebaseAuth auth, String bearer) throws Exception {
        @SuppressWarnings("unchecked")
        ObjectProvider<FirebaseAuth> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(auth);

        // No repository wired here (this is the claim→authority unit): getIfAvailable() returns null, so
        // the suspend gate (TM-741/TM-742) is absent — exactly the slim-slice fallback it's built for.
        @SuppressWarnings("unchecked")
        ObjectProvider<UserRepository> users = mock(ObjectProvider.class);
        when(users.getIfAvailable()).thenReturn(null);

        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("Authorization", "Bearer " + bearer);
        new FirebaseAuthenticationFilter(provider, users)
                .doFilter(request, new MockHttpServletResponse(), mock(FilterChain.class));
        return SecurityContextHolder.getContext().getAuthentication();
    }

    @Test
    void adminClaimGrantsRoleAdmin() throws Exception {
        Authentication authentication = authenticateWithClaims(Map.<String, Object>of("role", "ADMIN"));

        assertThat(authentication).isNotNull();
        assertThat(authentication.getAuthorities())
                .extracting("authority")
                .containsExactly("ROLE_ADMIN");
    }

    @Test
    void absentClaimDefaultsToRoleUser() throws Exception {
        Authentication authentication = authenticateWithClaims(Map.<String, Object>of());

        assertThat(authentication.getAuthorities())
                .extracting("authority")
                .containsExactly("ROLE_USER");
    }

    @Test
    void unknownClaimFailsSafeToRoleUser() throws Exception {
        Authentication authentication = authenticateWithClaims(Map.<String, Object>of("role", "superuser"));

        assertThat(authentication.getAuthorities())
                .extracting("authority")
                .containsExactly("ROLE_USER");
    }

    @Test
    void lowercaseAdminClaimIsAccepted() throws Exception {
        Authentication authentication = authenticateWithClaims(Map.<String, Object>of("role", "admin"));

        assertThat(authentication.getAuthorities())
                .extracting("authority")
                .containsExactly("ROLE_ADMIN");
    }

    /**
     * TM-723: verification uses {@code checkRevoked=true}, so a token whose session was revoked (e.g.
     * an admin demotion revoking the user's refresh tokens) fails verification and the request is left
     * unauthenticated — the fast lockout path. The Admin SDK signals this by throwing from the two-arg
     * {@code verifyIdToken(token, true)}; the filter treats it like any verification failure (→ 401).
     */
    @Test
    void revokedTokenLeavesRequestUnauthenticated() throws Exception {
        FirebaseAuth auth = mock(FirebaseAuth.class);
        when(auth.verifyIdToken(eq("revoked-token"), eq(true)))
                .thenThrow(mock(FirebaseAuthException.class));

        Authentication authentication = authenticateWith(auth, "revoked-token");

        assertThat(authentication).isNull();
    }

    /**
     * TM-738 P0 (auth): the suspension gate (TM-741/TM-742) at the unit level. Even a fully VALID,
     * non-revoked token must NOT authenticate a suspended account — the filter consults
     * {@code users.enabled} via {@link UserRepository#existsByFirebaseUidAndEnabledFalse} and, on a
     * suspended uid, clears the security context in the SAME request (never sets a {@code VerifiedUser}),
     * so the chain's entry point produces the uniform 401. It still proceeds down the chain (so the entry
     * point can run) rather than short-circuiting with a body of its own. This pins the security-negative
     * directly on the filter, independent of the full HTTP integration path: if this gate regressed, a
     * suspended user's still-live token (valid for its ~1h TTL) would silently regain API access.
     */
    @Test
    void filter_suspendedUidClearsContextInSameRequest_unit() throws Exception {
        FirebaseToken token = mock(FirebaseToken.class);
        when(token.getUid()).thenReturn("suspended-uid");
        when(token.getEmail()).thenReturn("suspended@example.com");
        FirebaseAuth auth = mock(FirebaseAuth.class);
        when(auth.verifyIdToken("valid-but-suspended-token", true)).thenReturn(token);

        @SuppressWarnings("unchecked")
        ObjectProvider<FirebaseAuth> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(auth);

        // Repository IS wired this time (the full-app case), and reports the uid as suspended.
        UserRepository repo = mock(UserRepository.class);
        when(repo.existsByFirebaseUidAndEnabledFalse("suspended-uid")).thenReturn(true);
        @SuppressWarnings("unchecked")
        ObjectProvider<UserRepository> users = mock(ObjectProvider.class);
        when(users.getIfAvailable()).thenReturn(repo);

        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("Authorization", "Bearer valid-but-suspended-token");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);
        new FirebaseAuthenticationFilter(provider, users).doFilter(request, response, chain);

        // Context left EMPTY despite the valid token — the suspended account never authenticates.
        assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
        // The gate was actually consulted for this uid...
        verify(repo).existsByFirebaseUidAndEnabledFalse("suspended-uid");
        // ...and the request still flows down the chain exactly once so the entry point can emit the 401
        // (the filter refuses by leaving the context empty, not by writing its own response).
        verify(chain, times(1)).doFilter(request, response);
    }

    /**
     * TM-738 P1 (auth): a malformed/missing {@code Authorization} header must leave the request
     * UNAUTHENTICATED — never crash, and never even touch Firebase. {@code bearerToken} only extracts a
     * token from a header that both {@code hasText} and starts with the exact {@code "Bearer "} prefix
     * (with a non-empty remainder); anything else yields {@code null}, so the filter skips verification
     * entirely and the security chain's entry point produces the uniform 401 for a protected route. This
     * pins each rejected shape at the unit level so a future header-parsing change can't quietly turn a
     * garbage header into an authenticated (or exception-throwing) request.
     *
     * <p>Each malformed header is asserted to (1) leave the context empty, (2) still pass the request
     * down the chain (so the entry point can run), and (3) never call {@code verifyIdToken} — proving the
     * filter short-circuits BEFORE Firebase on a non-Bearer header, rather than handing it a bad token.
     */
    @Test
    void filter_malformedAuthorizationHeaderLeavesUnauthenticated() throws Exception {
        String[] malformedHeaders = {
            "", // present but blank -> !hasText
            "   ", // whitespace only -> !hasText
            "Bearer", // the scheme with no space + no token
            "Bearer ", // the prefix but an empty (blanked to null) token
            "Bearer    ", // prefix + only whitespace -> trims to empty -> null
            "Basic dXNlcjpwYXNz", // a different auth scheme entirely
            "bearer good-token", // lowercase scheme -> not the exact "Bearer " prefix
            "Token good-token", // an unrelated scheme keyword
            "good-token" // a bare token with no scheme at all
        };

        for (String header : malformedHeaders) {
            FirebaseAuth auth = mock(FirebaseAuth.class);
            @SuppressWarnings("unchecked")
            ObjectProvider<FirebaseAuth> provider = mock(ObjectProvider.class);
            when(provider.getObject()).thenReturn(auth);
            @SuppressWarnings("unchecked")
            ObjectProvider<UserRepository> users = mock(ObjectProvider.class);
            when(users.getIfAvailable()).thenReturn(null);

            MockHttpServletRequest request = new MockHttpServletRequest();
            request.addHeader("Authorization", header);
            FilterChain chain = mock(FilterChain.class);
            MockHttpServletResponse response = new MockHttpServletResponse();

            SecurityContextHolder.clearContext();
            new FirebaseAuthenticationFilter(provider, users).doFilter(request, response, chain);

            assertThat(SecurityContextHolder.getContext().getAuthentication())
                    .as("header %s must leave the request unauthenticated", header)
                    .isNull();
            // The request still proceeds so the chain's entry point can emit the uniform 401.
            verify(chain, times(1)).doFilter(request, response);
            // And Firebase is never consulted for a non-Bearer header — the filter skips it before any
            // Admin-SDK call (so a garbage header can't throw from verifyIdToken either).
            verify(auth, never()).verifyIdToken(any(String.class), any(Boolean.class));
        }
    }

    /**
     * TM-738 P1 (auth) security-negative: when token verification FAILS (expired, malformed, or revoked),
     * the filter's catch branch must never log the token VALUE — only the exception message — so a
     * bearer token can't leak into logs an operator or log-sink could read. This captures everything the
     * filter logs during a failed verify and asserts the secret token string appears nowhere in it. The
     * failure path logs at DEBUG, so the logger level is lowered for the capture (prod may run at INFO,
     * but the point is the token must be absent at ANY level the branch could emit).
     */
    @Test
    void filter_expiredOrRevokedTokenNeverLogsTheTokenValue() throws Exception {
        String secretToken = "eyJhbGciOiJSUzI1NiJ9.SECRET-TOKEN-VALUE.sig-do-not-log";

        FirebaseAuth auth = mock(FirebaseAuth.class);
        // The two-arg verify (checkRevoked=true) throws for an expired/revoked/malformed token; the
        // message deliberately does NOT echo the token, so any leak would have to come from the filter.
        when(auth.verifyIdToken(eq(secretToken), eq(true)))
                .thenThrow(new RuntimeException("Firebase ID token has expired or is invalid"));

        // Capture everything FirebaseAuthenticationFilter logs during the failed verify.
        Logger filterLogger = (Logger) LoggerFactory.getLogger(FirebaseAuthenticationFilter.class);
        Level previousLevel = filterLogger.getLevel();
        filterLogger.setLevel(Level.DEBUG); // the catch branch logs at DEBUG
        ListAppender<ILoggingEvent> logAppender = new ListAppender<>();
        logAppender.start();
        filterLogger.addAppender(logAppender);
        try {
            Authentication authentication = authenticateWith(auth, secretToken);

            // The token failed verification -> the request is left unauthenticated (uniform 401 downstream).
            assertThat(authentication).isNull();

            // Whatever the branch logged, the raw token value must appear NOWHERE in it (message or args).
            StringBuilder captured = new StringBuilder();
            for (ILoggingEvent event : logAppender.list) {
                captured.append(event.getFormattedMessage()).append('\n');
                Object[] args = event.getArgumentArray();
                for (Object arg : args == null ? new Object[0] : args) {
                    captured.append(arg).append('\n');
                }
            }
            assertThat(captured.toString())
                    .as("the failed-verify log must never contain the bearer token value")
                    .doesNotContain(secretToken)
                    .doesNotContain("SECRET-TOKEN-VALUE");
        } finally {
            filterLogger.detachAppender(logAppender);
            filterLogger.setLevel(previousLevel);
        }
    }
}
