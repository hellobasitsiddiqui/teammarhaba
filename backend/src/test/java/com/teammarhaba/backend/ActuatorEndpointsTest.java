package com.teammarhaba.backend;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.auth.VerifiedUser;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * Verifies the Actuator authorization split (TM-74; tightened in TM-723): health is public for probes,
 * info/metrics are <strong>ADMIN-only</strong> (401 anonymous, 403 for an authenticated non-admin, 200
 * for an admin), and health detail is hidden from anonymous callers. Runs on the full context via the
 * shared Testcontainers harness (so the real {@link com.teammarhaba.backend.security.SecurityConfig}
 * and actuator endpoints are live).
 */
@AutoConfigureMockMvc
class ActuatorEndpointsTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    private static RequestPostProcessor withRole(String uid, String authority) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"),
                null,
                List.of(new SimpleGrantedAuthority(authority))));
    }

    @Test
    void healthIsPublicAndHidesDetailsFromAnonymous() throws Exception {
        mockMvc.perform(get("/actuator/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("UP"))
                .andExpect(jsonPath("$.components").doesNotExist());
    }

    @Test
    void livenessProbeIsPublic() throws Exception {
        mockMvc.perform(get("/actuator/health/liveness"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("UP"));
    }

    @Test
    void metricsRejectsAnonymous() throws Exception {
        mockMvc.perform(get("/actuator/metrics")).andExpect(status().isUnauthorized());
    }

    @Test
    void infoRejectsAnonymous() throws Exception {
        mockMvc.perform(get("/actuator/info")).andExpect(status().isUnauthorized());
    }

    // TM-723: info/metrics are an information-disclosure surface — ADMIN-only, not any signed-in user.

    @Test
    void metricsIsForbiddenForANonAdminUser() throws Exception {
        mockMvc.perform(get("/actuator/metrics").with(withRole("plain-user", "ROLE_USER")))
                .andExpect(status().isForbidden());
    }

    @Test
    void infoIsForbiddenForANonAdminUser() throws Exception {
        mockMvc.perform(get("/actuator/info").with(withRole("plain-user", "ROLE_USER")))
                .andExpect(status().isForbidden());
    }

    @Test
    void metricsIsReadableByAnAdmin() throws Exception {
        mockMvc.perform(get("/actuator/metrics").with(withRole("an-admin", "ROLE_ADMIN")))
                .andExpect(status().isOk());
    }

    @Test
    void infoIsReadableByAnAdmin() throws Exception {
        mockMvc.perform(get("/actuator/info").with(withRole("an-admin", "ROLE_ADMIN")))
                .andExpect(status().isOk());
    }

    @Test
    void skeletonHealthProbeStaysPublic() throws Exception {
        mockMvc.perform(get("/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("UP"));
    }
}
