package com.teammarhaba.backend.api;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The PUBLIC (any signed-in user) interests picker read endpoints (TM-776) under
 * {@code /api/v1/interests}: the active catalogue GET and the min/max-selection config GET. These back
 * the onboarding interests step, so the crux of the ticket is that a NON-ADMIN gets a {@code 200} here
 * (unlike the admin-only {@code /api/v1/admin/interests}, which 403s them), the list is active-only in
 * the picker order, and the response leaks NONE of the admin/internal fields.
 *
 * <p>The catalogue read is over the shared V45 seed rows (which the never-rolled-back Testcontainer
 * carries), so this suite only ADDS a few throwaway {@code ZZ …} rows (an active extra, an inactive one
 * and a retired/tombstoned one) via native SQL and removes them in {@code @AfterEach} — keeping every
 * sibling suite's seed assumptions intact. Native SQL is used both to insert (so a tombstoned fixture
 * can be created with {@code deleted_at} set) and to delete (so the entity's {@code @SQLRestriction}
 * can't hide a soft-deleted fixture from cleanup).
 */
@AutoConfigureMockMvc
class InterestCatalogueControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private AppConfigService appConfig;

    @AfterEach
    void cleanup() {
        jdbc.update("DELETE FROM interest_catalogue WHERE label LIKE 'ZZ %'");
        appConfig.setInt("interests.min_selections", 1);
        appConfig.setInt("interests.max_selections", 3);
    }

    private static RequestPostProcessor user(String uid) {
        return principal(uid, "ROLE_USER");
    }

    private static RequestPostProcessor admin(String uid) {
        return principal(uid, "ROLE_ADMIN");
    }

    private static RequestPostProcessor principal(String uid, String authority) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of(new SimpleGrantedAuthority(authority))));
    }

    /** Insert a throwaway catalogue row via native SQL (so a tombstoned fixture can carry deleted_at). */
    private void insertRow(String label, boolean active, boolean retired) {
        jdbc.update(
                "INSERT INTO interest_catalogue (label, category, highlighted, sort_weight, active, updated_at, deleted_at)"
                        + " VALUES (?, 'Food & Drink', false, 0, ?, now(), ?)",
                label,
                active,
                retired ? java.sql.Timestamp.from(java.time.Instant.now()) : null);
    }

    @Test
    void catalogueIsReadableByAPlainUser() throws Exception {
        // The whole point of TM-776: a fresh onboarding USER (not an admin) can read the picker.
        mockMvc.perform(get("/api/v1/interests/catalogue").with(user("cat-plain-user")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isArray())
                .andExpect(jsonPath("$[0].label").exists())
                .andExpect(jsonPath("$[0].category").exists());
    }

    @Test
    void catalogueRowsCarryOnlyTheLeanPublicFields() throws Exception {
        // Lean projection: label/category/highlighted/sortWeight only — NO admin/internal leak.
        mockMvc.perform(get("/api/v1/interests/catalogue").with(user("cat-lean-user")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].label").exists())
                .andExpect(jsonPath("$[0].category").exists())
                .andExpect(jsonPath("$[0].highlighted").exists())
                .andExpect(jsonPath("$[0].sortWeight").exists())
                .andExpect(jsonPath("$[0].id").doesNotExist())
                .andExpect(jsonPath("$[0].active").doesNotExist())
                .andExpect(jsonPath("$[0].createdAt").doesNotExist())
                .andExpect(jsonPath("$[0].updatedAt").doesNotExist())
                .andExpect(jsonPath("$[0].deletedAt").doesNotExist())
                .andExpect(jsonPath("$[0].version").doesNotExist());
    }

    @Test
    void catalogueIsSortedHighlightsFirstThenLabel() throws Exception {
        // The very first row must be a highlighted (weight-100) seed row — highlights float to the top.
        mockMvc.perform(get("/api/v1/interests/catalogue").with(user("cat-order-user")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].highlighted").value(true))
                .andExpect(jsonPath("$[0].sortWeight").value(100));
    }

    @Test
    void catalogueExcludesRetiredAndInactiveRows() throws Exception {
        insertRow("ZZ Active Extra", true, false);
        insertRow("ZZ Inactive Extra", false, false); // present but not offered (active=false)
        insertRow("ZZ Retired Extra", false, true); // soft-deleted (tombstoned)

        mockMvc.perform(get("/api/v1/interests/catalogue").with(user("cat-filter-user")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[?(@.label == 'ZZ Active Extra')]").exists())
                .andExpect(jsonPath("$[?(@.label == 'ZZ Inactive Extra')]").doesNotExist())
                .andExpect(jsonPath("$[?(@.label == 'ZZ Retired Extra')]").doesNotExist());
    }

    @Test
    void configReturnsSeededOneAndThreeForAPlainUser() throws Exception {
        mockMvc.perform(get("/api/v1/interests/config").with(user("cfg-plain-user")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.minSelections").value(1))
                .andExpect(jsonPath("$.maxSelections").value(3));
    }

    @Test
    void configReflectsAnAdminChange() throws Exception {
        appConfig.setInt("interests.min_selections", 2);
        appConfig.setInt("interests.max_selections", 5);
        mockMvc.perform(get("/api/v1/interests/config").with(user("cfg-changed-user")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.minSelections").value(2))
                .andExpect(jsonPath("$.maxSelections").value(5));
    }

    @Test
    void adminMayAlsoReadThePublicEndpoints() throws Exception {
        mockMvc.perform(get("/api/v1/interests/catalogue").with(admin("cat-admin")))
                .andExpect(status().isOk());
        mockMvc.perform(get("/api/v1/interests/config").with(admin("cfg-admin")))
                .andExpect(status().isOk());
    }
}
