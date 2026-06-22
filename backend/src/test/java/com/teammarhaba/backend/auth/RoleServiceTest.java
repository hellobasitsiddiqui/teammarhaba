package com.teammarhaba.backend.auth;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.google.firebase.auth.FirebaseAuth;
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
}
