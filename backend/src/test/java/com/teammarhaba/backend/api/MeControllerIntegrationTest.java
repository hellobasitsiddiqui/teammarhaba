package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.UserRepository;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * {@code /api/v1/me} (TM-107 + TM-112): an authenticated caller gets their persisted profile,
 * provisioned just-in-time on first call and reused afterwards; {@code PATCH} updates the
 * display name; an anonymous caller gets the uniform {@code 401}. The authenticated case injects
 * a {@link VerifiedUser} principal directly (token verification is exercised separately).
 */
@AutoConfigureMockMvc
class MeControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository users;

    private static RequestPostProcessor caller(String uid, String email) {
        return authentication(new UsernamePasswordAuthenticationToken(new VerifiedUser(uid, email), null, List.of()));
    }

    @Test
    void provisionsOnFirstCallThenReuses() throws Exception {
        mockMvc.perform(get("/api/v1/me").with(caller("uid-new", "ada@example.com")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.uid").value("uid-new"))
                .andExpect(jsonPath("$.email").value("ada@example.com"))
                .andExpect(jsonPath("$.displayName").doesNotExist())
                .andExpect(jsonPath("$.role").value("USER"));

        Long firstId = users.findByFirebaseUid("uid-new").orElseThrow().getId();

        // Second call reuses the same row — no duplicate provisioning.
        mockMvc.perform(get("/api/v1/me").with(caller("uid-new", "ada@example.com"))).andExpect(status().isOk());

        assertThat(users.findByFirebaseUid("uid-new").orElseThrow().getId()).isEqualTo(firstId);
        assertThat(users.findAll().stream().filter(u -> u.getFirebaseUid().equals("uid-new")).count())
                .isEqualTo(1);
    }

    @Test
    void patchUpdatesDisplayName() throws Exception {
        var who = caller("uid-patch", "grace@example.com");

        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"displayName\":\"Grace H\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.displayName").value("Grace H"));

        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.displayName").value("Grace H"));
    }

    @Test
    void rejectsAnonymousWith401() throws Exception {
        mockMvc.perform(get("/api/v1/me")).andExpect(status().isUnauthorized());
    }
}
