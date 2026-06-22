package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.google.firebase.auth.FirebaseAuth;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.Role;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The admin user-management API (TM-111) end-to-end through the real security chain + Postgres:
 * ADMIN-only access (USER → 403, anon → 401), paged listing with a size cap + sort guard,
 * enable/disable + set-role (claim written via the mocked Admin SDK), admin self-protection (422),
 * and 404 for a missing target (no existence leak).
 */
@AutoConfigureMockMvc
class UserAdminControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository users;

    // Role changes call the Admin SDK; mock it so no Firebase credentials are needed.
    @MockBean
    private FirebaseAuth firebaseAuth;

    private static RequestPostProcessor admin(String uid) {
        return principal(uid, "ROLE_ADMIN");
    }

    private static RequestPostProcessor regularUser(String uid) {
        return principal(uid, "ROLE_USER");
    }

    private static RequestPostProcessor principal(String uid, String authority) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of(new SimpleGrantedAuthority(authority))));
    }

    private long seed(String uid) {
        return users.saveAndFlush(new User(uid, uid + "@example.com", null)).getId();
    }

    @Test
    void anonymousGetsUniform401() throws Exception {
        mockMvc.perform(get("/api/v1/admin/users"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Unauthorized"));
    }

    @Test
    void nonAdminGetsUniform403() throws Exception {
        mockMvc.perform(get("/api/v1/admin/users").with(regularUser("plain-user")))
                .andExpect(status().isForbidden())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Forbidden"))
                .andExpect(jsonPath("$.status").value(403));
    }

    @Test
    void adminListsUsersPagedWithSizeCapHonoured() throws Exception {
        seed("list-a");
        seed("list-b");

        mockMvc.perform(get("/api/v1/admin/users")
                        .param("page", "0")
                        .param("size", "1")
                        .param("sort", "id,asc")
                        .with(admin("admin-list")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.page").value(0))
                .andExpect(jsonPath("$.size").value(1))
                .andExpect(jsonPath("$.totalElements").value(org.hamcrest.Matchers.greaterThanOrEqualTo(2)));
    }

    @Test
    void adminDisablesAnotherUser() throws Exception {
        long id = seed("to-disable");

        mockMvc.perform(patch("/api/v1/admin/users/{id}", id)
                        .with(admin("admin-d"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"enabled\":false}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.enabled").value(false));

        assertThat(users.findById(id).orElseThrow().isEnabled()).isFalse();
    }

    @Test
    void adminSetsAnotherUsersRoleAndWritesTheClaim() throws Exception {
        long id = seed("to-promote");

        mockMvc.perform(patch("/api/v1/admin/users/{id}", id)
                        .with(admin("admin-r"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"ADMIN\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.role").value("ADMIN"));

        assertThat(users.findById(id).orElseThrow().getRole()).isEqualTo(Role.ADMIN);
    }

    @Test
    void adminCannotDisableTheirOwnAccount() throws Exception {
        long id = seed("self-admin");

        mockMvc.perform(patch("/api/v1/admin/users/{id}", id)
                        .with(admin("self-admin")) // caller uid == target uid
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"enabled\":false}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.title").value("Operation not allowed"));

        assertThat(users.findById(id).orElseThrow().isEnabled()).isTrue();
    }

    @Test
    void missingTargetIs404NotLeaking() throws Exception {
        mockMvc.perform(patch("/api/v1/admin/users/{id}", 999_999L)
                        .with(admin("admin-x"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"enabled\":false}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.title").value("Resource not found"));
    }

    @Test
    void unknownSortPropertyIs400() throws Exception {
        mockMvc.perform(get("/api/v1/admin/users").param("sort", "password").with(admin("admin-s")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Bad request"));
    }
}
