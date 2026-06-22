package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseToken;
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
        when(auth.verifyIdToken("good-token")).thenReturn(token);

        @SuppressWarnings("unchecked")
        ObjectProvider<FirebaseAuth> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(auth);

        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("Authorization", "Bearer good-token");
        new FirebaseAuthenticationFilter(provider)
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
}
