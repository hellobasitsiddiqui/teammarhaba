package com.teammarhaba.backend.api;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;

/**
 * {@code GET /api/v1/me} (TM-107): an authenticated caller gets their identity back; an
 * anonymous caller gets the uniform {@code 401}. The authenticated case injects a
 * {@link VerifiedUser} principal directly (the token-verification filter is exercised
 * separately), keeping this focused on the endpoint's contract.
 */
@AutoConfigureMockMvc
class MeControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void returnsTheVerifiedCaller() throws Exception {
        var principal = new VerifiedUser("uid-123", "ada@example.com");
        var auth = new UsernamePasswordAuthenticationToken(principal, null, List.of());

        mockMvc.perform(get("/api/v1/me").with(authentication(auth)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.uid").value("uid-123"))
                .andExpect(jsonPath("$.email").value("ada@example.com"))
                .andExpect(jsonPath("$.displayName").doesNotExist())
                .andExpect(jsonPath("$.role").value("USER"));
    }

    @Test
    void rejectsAnonymousWith401() throws Exception {
        mockMvc.perform(get("/api/v1/me")).andExpect(status().isUnauthorized());
    }
}
