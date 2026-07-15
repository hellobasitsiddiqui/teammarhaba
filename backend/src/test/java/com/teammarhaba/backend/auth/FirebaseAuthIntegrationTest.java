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
import com.teammarhaba.backend.user.Role;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserAdminService;
import com.teammarhaba.backend.user.UserRepository;
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

    @Autowired
    private UserRepository users;

    @Autowired
    private UserAdminService userAdmin;

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

    /**
     * TM-741/TM-742: an admin "disable/suspend" ({@code users.enabled = false}) must block API access
     * inbound, in the very next request — not merely stop outbound notifications. Here a valid, still-
     * verifying (non-revoked) token belongs to an account an admin has just suspended; the request must
     * be refused with the uniform 401, proving the filter's {@code enabled} gate, independently of any
     * Firebase-side token revocation (which is a best-effort defence and unavailable under a mocked SDK).
     * Before this fix the same token reached {@code /api/v1/ping} with a 200.
     */
    @Test
    void suspendedAccountIsRejectedEvenWithAValidToken() throws Exception {
        // Seed an active account and take the admin "disable" action through the real service path (which
        // flips enabled=false + audits). A second uid is the acting admin so self-disable protection —
        // an admin can't disable their own session — is not tripped.
        User target = users.save(new User("suspended-uid", "suspended@example.com", "Target"));
        userAdmin.update(target.getId(), false, (Role) null, "admin-uid");

        // A token that verifies fine (checkRevoked=true): the account is suspended in OUR DB, but the
        // Firebase token itself is still valid — exactly the gap. Only the inbound enabled gate can catch it.
        FirebaseToken token = mock(FirebaseToken.class);
        when(token.getUid()).thenReturn("suspended-uid");
        when(token.getEmail()).thenReturn("suspended@example.com");
        when(firebaseAuth.verifyIdToken("suspended-token", true)).thenReturn(token);

        mockMvc.perform(get("/api/v1/ping").header(HttpHeaders.AUTHORIZATION, "Bearer suspended-token"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Unauthorized"));
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
