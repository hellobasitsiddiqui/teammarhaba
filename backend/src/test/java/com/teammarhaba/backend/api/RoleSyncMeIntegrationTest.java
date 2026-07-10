package com.teammarhaba.backend.api;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.google.firebase.auth.FirebaseAuth;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.RoleService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.Role;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * TM-140 (defect 3): assigning a role must keep the DB {@code users.role} in step so
 * {@code GET /api/v1/me} reflects it. Previously {@link RoleService#assignRole} wrote only the
 * Firebase custom claim, so {@code /me} (which reads the row) showed a stale {@code USER} even
 * once the caller was authorized as {@code ADMIN}.
 */
@AutoConfigureMockMvc
class RoleSyncMeIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private RoleService roleService;

    // assignRole writes a custom claim via the Admin SDK; mock it so no Firebase creds are needed.
    @MockBean
    private FirebaseAuth firebaseAuth;

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    @Test
    void assigningAdminIsReflectedByMe() throws Exception {
        var who = caller("uid-rolesync");

        // First call provisions the account — default role USER, so the admin flag (TM-589) is false.
        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.role").value("USER"))
                .andExpect(jsonPath("$.admin").value(false));

        // Assign ADMIN: the claim write is a no-op on the mock, but the DB row must be synced.
        roleService.assignRole("uid-rolesync", Role.ADMIN);

        // /me now reflects ADMIN (the TM-140 fix) — and the derived admin flag (TM-589) flips to true, so
        // the client can gate app-admin UI (e.g. the TM-449 moderation controls) on it.
        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.role").value("ADMIN"))
                .andExpect(jsonPath("$.admin").value(true));
    }
}
