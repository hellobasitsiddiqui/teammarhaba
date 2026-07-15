package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseAuthException;
import com.google.firebase.auth.FirebaseToken;
import com.teammarhaba.backend.user.UserRepository;
import jakarta.servlet.FilterChain;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
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
}
