package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseAuthException;
import com.teammarhaba.backend.user.Role;
import com.teammarhaba.backend.user.UserService;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

/**
 * {@link RoleService} writes the role as the {@code role} custom claim via the Admin SDK (TM-110)
 * and mirrors it onto the DB row so {@code /me} stays in sync (TM-140).
 */
class RoleServiceTest {

    @Test
    void assignRoleWritesTheClaimAndSyncsTheDbRow() throws Exception {
        FirebaseAuth auth = mock(FirebaseAuth.class);
        @SuppressWarnings("unchecked")
        ObjectProvider<FirebaseAuth> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(auth);
        UserService userService = mock(UserService.class);

        new RoleService(provider, userService).assignRole("uid-42", Role.ADMIN);

        verify(auth).setCustomUserClaims("uid-42", Map.of("role", "ADMIN"));
        verify(userService).syncRole("uid-42", Role.ADMIN);
    }

    /**
     * TM-738 P1 (auth): the claim is the authorization source of truth, so it is written FIRST and the
     * DB-row mirror only follows if it succeeds. If the Admin-SDK {@code setCustomUserClaims} call fails,
     * {@code assignRole} must propagate the failure and NOT run {@code userService.syncRole} — otherwise
     * the {@code users.role} column would advertise a role the Firebase claim never granted (a
     * claim/DB desync where {@code /me} shows ADMIN while the authoritative claim is still USER). This
     * pins the ordering guarantee: on a claim-write failure the row is left exactly as it was.
     */
    @Test
    void assignRole_firebaseFailureDoesNotDesyncDbRow() throws Exception {
        FirebaseAuth auth = mock(FirebaseAuth.class);
        // The Admin-SDK claim write fails (e.g. the uid does not exist, or the SDK is unavailable).
        // setCustomUserClaims returns void, so stub with doThrow(...).when(...).
        doThrow(mock(FirebaseAuthException.class)).when(auth).setCustomUserClaims(anyString(), any());
        @SuppressWarnings("unchecked")
        ObjectProvider<FirebaseAuth> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(auth);
        UserService userService = mock(UserService.class);

        // The failure propagates to the caller (it is not swallowed)...
        assertThatThrownBy(() -> new RoleService(provider, userService).assignRole("uid-99", Role.ADMIN))
                .isInstanceOf(FirebaseAuthException.class);

        // ...and, crucially, the DB row is NEVER touched — no half-applied role that outlives the failed
        // claim write. verify(...) with the exact args, then a belt-and-braces "never any syncRole at all".
        verify(userService, never()).syncRole("uid-99", Role.ADMIN);
        verify(userService, never()).syncRole(anyString(), any(Role.class));
    }
}
