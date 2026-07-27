package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseAuthException;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Unit tests for {@link SessionRevocationService} (TM-924 "sign out everywhere"). Mirrors the mocking
 * style of {@code UserAdminServiceTest}'s demotion-revoke tests: the {@link FirebaseAuth} bean is
 * resolved through a mocked {@link ObjectProvider}, so both the real-revoke path and the degrade-quietly
 * path (no Admin SDK bean in dev/test/CI) are exercised without credentials.
 */
class SessionRevocationServiceTest {

    @SuppressWarnings("unchecked")
    private final ObjectProvider<FirebaseAuth> firebaseAuthProvider = mock(ObjectProvider.class);

    private final AuditService audit = mock(AuditService.class);

    private final SessionRevocationService service = new SessionRevocationService(firebaseAuthProvider, audit);

    @Test
    void signOutEverywhereRevokesRefreshTokensAndAuditsOnSuccess() throws FirebaseAuthException {
        FirebaseAuth auth = mock(FirebaseAuth.class);
        when(firebaseAuthProvider.getIfAvailable()).thenReturn(auth);

        boolean revoked = service.signOutEverywhere("uid-abc");

        assertThat(revoked).isTrue();
        verify(auth).revokeRefreshTokens("uid-abc");
        // One SESSIONS_REVOKED_ALL audit row, the account revoking itself (target = its own uid).
        verify(audit).record(eq("uid-abc"), eq(AuditAction.SESSIONS_REVOKED_ALL), eq("User"), eq("uid-abc"));
    }

    @Test
    void signOutEverywhereDegradesToFalseWhenNoAdminSdkBean() {
        // No FirebaseAuth bean (dev/test/CI without credentials): never throw, just report "not revoked".
        when(firebaseAuthProvider.getIfAvailable()).thenReturn(null);

        boolean revoked = service.signOutEverywhere("uid-nobean");

        assertThat(revoked).isFalse();
        verify(audit, never()).record(any(), any(), any(), any());
    }

    @Test
    void signOutEverywhereDegradesToFalseWhenProviderThrowsOnResolution() {
        // The lazy bean definition exists but creation throws (no ADC in CI) — treated as "can't revoke".
        when(firebaseAuthProvider.getIfAvailable()).thenThrow(new RuntimeException("no ADC"));

        boolean revoked = service.signOutEverywhere("uid-throw");

        assertThat(revoked).isFalse();
        verify(audit, never()).record(any(), any(), any(), any());
    }

    @Test
    void signOutEverywhereDegradesToFalseWhenRevokeItselfFails() throws FirebaseAuthException {
        FirebaseAuth auth = mock(FirebaseAuth.class);
        when(firebaseAuthProvider.getIfAvailable()).thenReturn(auth);
        doThrow(mock(FirebaseAuthException.class)).when(auth).revokeRefreshTokens("uid-fail");

        boolean revoked = service.signOutEverywhere("uid-fail");

        // A revoke failure is swallowed (logged) and reported as not-revoked — the endpoint still 2xx's.
        assertThat(revoked).isFalse();
        // No audit row on a failed revoke — only an ACTUAL revoke is audited.
        verify(audit, never()).record(any(), any(), any(), any());
    }
}
