package com.teammarhaba.backend.api;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The admin audit read endpoint (TM-137) end-to-end through the real security chain + Postgres:
 * an admin action writes an audit event and the endpoint reads it back (ADMIN-only; USER → 403,
 * anon → 401). Also proves the wiring: PATCH disable now appends an {@code ACCOUNT_ENABLED_CHANGED}
 * event attributed to the acting admin.
 */
@AutoConfigureMockMvc
class AuditControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository users;

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

    @Test
    void adminActionIsAuditedAndReadableForTheTarget() throws Exception {
        long id = users.saveAndFlush(new User("audit-target", "audit-target@example.com", null)).getId();

        // Act: an admin disables the account — this should append an audit event.
        mockMvc.perform(patch("/api/v1/admin/users/{id}", id)
                        .with(admin("acting-admin"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"enabled\":false}"))
                .andExpect(status().isOk());

        // Read: the audit endpoint returns it (targetType matched case-insensitively: "user" vs stored "User").
        mockMvc.perform(get("/api/v1/audit")
                        .param("targetType", "user")
                        .param("targetId", String.valueOf(id))
                        .with(admin("reader-admin")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.items[0].action").value("ACCOUNT_ENABLED_CHANGED"))
                .andExpect(jsonPath("$.items[0].targetType").value("User"))
                .andExpect(jsonPath("$.items[0].targetId").value(String.valueOf(id)))
                .andExpect(jsonPath("$.items[0].actorUid").value("acting-admin"))
                .andExpect(jsonPath("$.items[0].metadata.enabled").value(false))
                .andExpect(jsonPath("$.items[0].createdAt").exists());
    }

    @Test
    void nonAdminGetsUniform403() throws Exception {
        mockMvc.perform(get("/api/v1/audit").with(regularUser("plain-user")))
                .andExpect(status().isForbidden())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Forbidden"))
                .andExpect(jsonPath("$.status").value(403));
    }

    @Test
    void anonymousGetsUniform401() throws Exception {
        mockMvc.perform(get("/api/v1/audit"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Unauthorized"));
    }
}
