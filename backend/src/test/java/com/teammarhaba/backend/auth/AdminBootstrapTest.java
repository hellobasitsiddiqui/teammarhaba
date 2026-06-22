package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.UserRecord;
import com.teammarhaba.backend.config.AdminProperties;
import com.teammarhaba.backend.user.Role;
import com.teammarhaba.backend.user.UserService;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

/**
 * The env-driven first-admin bootstrap (TM-110): promotes the configured email to {@code ADMIN}, is
 * idempotent, never touches Firebase when unconfigured, and never fails startup on Admin SDK errors.
 */
class AdminBootstrapTest {

    private final FirebaseAuth auth = mock(FirebaseAuth.class);
    private final RoleService roleService = mock(RoleService.class);
    private final UserService userService = mock(UserService.class);

    @SuppressWarnings("unchecked")
    private final ObjectProvider<FirebaseAuth> provider = mock(ObjectProvider.class);

    private AdminBootstrap bootstrap(String email) {
        return new AdminBootstrap(new AdminProperties(email), provider, roleService, userService);
    }

    @Test
    void blankEmailNeverTouchesFirebaseOrRoleService() {
        bootstrap("   ").run(null);
        verifyNoInteractions(provider);
        verifyNoInteractions(roleService);
        verifyNoInteractions(userService);
    }

    @Test
    void nullEmailNeverTouchesFirebase() {
        bootstrap(null).run(null);
        verifyNoInteractions(provider);
        verifyNoInteractions(roleService);
        verifyNoInteractions(userService);
    }

    @Test
    void promotesConfiguredEmailWhenNotYetAdmin() throws Exception {
        UserRecord user = mock(UserRecord.class);
        when(user.getUid()).thenReturn("uid-admin");
        when(user.getCustomClaims()).thenReturn(Map.of()); // currently USER
        when(provider.getObject()).thenReturn(auth);
        when(auth.getUserByEmail("boss@example.com")).thenReturn(user);

        bootstrap("boss@example.com").run(null);

        verify(roleService).assignRole("uid-admin", Role.ADMIN);
    }

    @Test
    void whenClaimAlreadyAdminReconcilesDbRowWithoutRewritingClaim() throws Exception {
        UserRecord user = mock(UserRecord.class);
        when(user.getUid()).thenReturn("uid-admin");
        when(user.getCustomClaims()).thenReturn(Map.of("role", "ADMIN"));
        when(provider.getObject()).thenReturn(auth);
        when(auth.getUserByEmail("boss@example.com")).thenReturn(user);

        bootstrap("boss@example.com").run(null);

        // The claim is left untouched (no assignRole), but the DB row is still reconciled (TM-140).
        verify(roleService, never()).assignRole(any(), eq(Role.ADMIN));
        verify(userService).syncRole("uid-admin", Role.ADMIN);
    }

    @Test
    void swallowsAdminSdkErrorsSoStartupSurvives() throws Exception {
        when(provider.getObject()).thenReturn(auth);
        when(auth.getUserByEmail("missing@example.com"))
                .thenThrow(new RuntimeException("USER_NOT_FOUND"));

        assertThatCode(() -> bootstrap("missing@example.com").run(null)).doesNotThrowAnyException();
        verifyNoInteractions(roleService);
    }
}
