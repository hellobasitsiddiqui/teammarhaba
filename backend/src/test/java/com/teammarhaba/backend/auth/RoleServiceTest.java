package com.teammarhaba.backend.auth;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.google.firebase.auth.FirebaseAuth;
import com.teammarhaba.backend.user.Role;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

/** {@link RoleService} writes the role as the {@code role} custom claim via the Admin SDK (TM-110). */
class RoleServiceTest {

    @Test
    void assignRoleWritesTheRoleCustomClaim() throws Exception {
        FirebaseAuth auth = mock(FirebaseAuth.class);
        @SuppressWarnings("unchecked")
        ObjectProvider<FirebaseAuth> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(auth);

        new RoleService(provider).assignRole("uid-42", Role.ADMIN);

        verify(auth).setCustomUserClaims("uid-42", Map.of("role", "ADMIN"));
    }
}
