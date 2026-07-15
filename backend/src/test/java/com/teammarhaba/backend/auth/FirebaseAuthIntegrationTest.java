package com.teammarhaba.backend.auth;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseToken;
import com.teammarhaba.backend.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/**
 * End-to-end auth seam (TM-79) with a mocked {@link FirebaseAuth} (no real token verification):
 * a valid token reaches a protected endpoint and the caller identity is available; a
 * missing/invalid token is rejected with a JSON 401 in the RFC 7807 shape; a public endpoint
 * needs no token. Runs the full security chain on the shared Testcontainers harness.
 */
@AutoConfigureMockMvc
class FirebaseAuthIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private FirebaseAuth firebaseAuth;

    @Test
    void validTokenReachesProtectedEndpointWithCallerIdentity() throws Exception {
        FirebaseToken token = mock(FirebaseToken.class);
        when(token.getUid()).thenReturn("uid-123");
        when(token.getEmail()).thenReturn("user@example.com");
        // The filter verifies with checkRevoked=true (TM-723), so stub the two-arg overload.
        when(firebaseAuth.verifyIdToken("valid-token", true)).thenReturn(token);

        mockMvc.perform(get("/api/v1/ping").header(HttpHeaders.AUTHORIZATION, "Bearer valid-token"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.uid").value("uid-123"))
                .andExpect(jsonPath("$.email").value("user@example.com"));
    }

    @Test
    void missingTokenIsRejectedWith401ProblemJson() throws Exception {
        mockMvc.perform(get("/api/v1/ping"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Unauthorized"))
                .andExpect(jsonPath("$.status").value(401));
    }

    @Test
    void invalidTokenIsRejectedWith401() throws Exception {
        when(firebaseAuth.verifyIdToken("bad-token", true)).thenThrow(new RuntimeException("invalid token"));

        mockMvc.perform(get("/api/v1/ping").header(HttpHeaders.AUTHORIZATION, "Bearer bad-token"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Unauthorized"));
    }

    @Test
    void publicEndpointNeedsNoToken() throws Exception {
        mockMvc.perform(get("/actuator/health")).andExpect(status().isOk());
    }
}
