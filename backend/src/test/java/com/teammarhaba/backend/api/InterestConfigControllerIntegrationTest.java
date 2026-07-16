package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.appconfig.AppConfigService;
import com.teammarhaba.backend.auth.VerifiedUser;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The admin interests-config endpoints (TM-774): GET + PUT the min/max-selection bounds under
 * {@code /api/v1/admin/interests/config}, admin-only.
 *
 * <p>These two rows ({@code interests.min_selections} / {@code interests.max_selections}) are the
 * SHARED V45 seed rows read by other suites, so any test that writes them MUST reset to the 1/3
 * defaults in {@code @AfterEach} — otherwise a leftover value pollutes {@code
 * InterestSelectionConfig} reads elsewhere on the never-rolled-back Testcontainer.
 */
@AutoConfigureMockMvc
class InterestConfigControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AppConfigService appConfig;

    @AfterEach
    void resetSeedDefaults() {
        // Restore the shared seed rows to their V45 defaults so sibling suites see 1/3.
        appConfig.setInt("interests.min_selections", 1);
        appConfig.setInt("interests.max_selections", 3);
    }

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
    void getConfigReturnsSeededOneAndThree() throws Exception {
        mockMvc.perform(get("/api/v1/admin/interests/config").with(admin("cfg-admin-get")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.minSelections").value(1))
                .andExpect(jsonPath("$.maxSelections").value(3));
    }

    @Test
    void setConfigUpdatesBothKeys() throws Exception {
        mockMvc.perform(put("/api/v1/admin/interests/config")
                        .with(admin("cfg-admin-set"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"minSelections\":2,\"maxSelections\":5}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.minSelections").value(2))
                .andExpect(jsonPath("$.maxSelections").value(5));

        // GET reflects the new values ...
        mockMvc.perform(get("/api/v1/admin/interests/config").with(admin("cfg-admin-set")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.minSelections").value(2))
                .andExpect(jsonPath("$.maxSelections").value(5));

        // ... and the AppConfig rows really changed in the DB.
        assertThat(appConfig.getInt("interests.min_selections", -1)).isEqualTo(2);
        assertThat(appConfig.getInt("interests.max_selections", -1)).isEqualTo(5);
    }

    @Test
    void setConfigRejectsMinBelowOne() throws Exception {
        mockMvc.perform(put("/api/v1/admin/interests/config")
                        .with(admin("cfg-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"minSelections\":0,\"maxSelections\":3}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));
    }

    @Test
    void setConfigRejectsMaxLessThanMin() throws Exception {
        mockMvc.perform(put("/api/v1/admin/interests/config")
                        .with(admin("cfg-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"minSelections\":4,\"maxSelections\":2}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));
    }

    @Test
    void setConfigRejectsMissingField() throws Exception {
        mockMvc.perform(put("/api/v1/admin/interests/config")
                        .with(admin("cfg-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"minSelections\":2}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'maxSelections')]").exists());
    }

    @Test
    void nonAdminCannotGetOrSetConfig() throws Exception {
        mockMvc.perform(get("/api/v1/admin/interests/config").with(regularUser("cfg-plain-user")))
                .andExpect(status().isForbidden());

        mockMvc.perform(put("/api/v1/admin/interests/config")
                        .with(regularUser("cfg-plain-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"minSelections\":2,\"maxSelections\":5}"))
                .andExpect(status().isForbidden());
    }
}
