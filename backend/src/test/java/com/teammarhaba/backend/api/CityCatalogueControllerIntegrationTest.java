package com.teammarhaba.backend.api;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
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
 * The PUBLIC (any signed-in user) cities picker read endpoint (TM-1089) under {@code /api/v1/cities}:
 * the active catalogue GET. Mirrors {@link InterestCatalogueControllerIntegrationTest}. The crux: a
 * NON-ADMIN gets a {@code 200} here (unlike the admin-only {@code /api/v1/admin/cities}, which 403s
 * them), the list is active-only in the picker order, it surfaces the seeded icon + geo, and it leaks
 * NONE of the admin/internal fields (nor the big-image path).
 *
 * <p>The read is over the four V54 seed cities (which the never-rolled-back Testcontainer carries), so
 * this suite only ADDS a few throwaway {@code ZZ …} rows via native SQL (so a tombstoned fixture can
 * carry {@code deleted_at}) and removes them in {@code @AfterEach}.
 */
@AutoConfigureMockMvc
class CityCatalogueControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbc;

    @AfterEach
    void cleanup() {
        jdbc.update("DELETE FROM city_catalogue WHERE name LIKE 'ZZ %'");
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
    private void insertRow(String name, boolean active, boolean retired) {
        jdbc.update(
                "INSERT INTO city_catalogue (name, country, icon_emoji, sort_weight, active, updated_at, deleted_at)"
                        + " VALUES (?, 'Testonia', null, 0, ?, now(), ?)",
                name,
                active,
                retired ? java.sql.Timestamp.from(java.time.Instant.now()) : null);
    }

    @Test
    void catalogueIsReadableByAPlainUser() throws Exception {
        // The point: a fresh onboarding USER (not an admin) can read the picker.
        mockMvc.perform(get("/api/v1/cities/catalogue").with(user("city-plain-user")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isArray())
                .andExpect(jsonPath("$[0].name").exists())
                .andExpect(jsonPath("$[0].country").exists());
    }

    @Test
    void catalogueRowsCarryOnlyTheLeanPublicFields() throws Exception {
        // Lean projection: name/country/iconEmoji/geo only — NO admin/internal leak, no imagePath/sortWeight.
        mockMvc.perform(get("/api/v1/cities/catalogue").with(user("city-lean-user")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].name").exists())
                .andExpect(jsonPath("$[0].country").exists())
                .andExpect(jsonPath("$[0].iconEmoji").exists())
                .andExpect(jsonPath("$[0].geoLat").exists())
                .andExpect(jsonPath("$[0].geoLng").exists())
                .andExpect(jsonPath("$[0].id").doesNotExist())
                .andExpect(jsonPath("$[0].active").doesNotExist())
                .andExpect(jsonPath("$[0].sortWeight").doesNotExist())
                .andExpect(jsonPath("$[0].imagePath").doesNotExist())
                .andExpect(jsonPath("$[0].createdAt").doesNotExist())
                .andExpect(jsonPath("$[0].updatedAt").doesNotExist())
                .andExpect(jsonPath("$[0].deletedAt").doesNotExist())
                .andExpect(jsonPath("$[0].version").doesNotExist());
    }

    @Test
    void catalogueSurfacesTheSeededIconAndGeo() throws Exception {
        // The V54-seeded icon + geo flow through PublicCityResponse. Find the known 'London' row and
        // assert it carries its flag glyph + latitude.
        mockMvc.perform(get("/api/v1/cities/catalogue").with(user("city-geo-user")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[?(@.name == 'London')].iconEmoji").value("🇬🇧"))
                .andExpect(jsonPath("$[?(@.name == 'London')].geoLat").value(51.5074))
                .andExpect(jsonPath("$[?(@.name == 'London')].country").value("United Kingdom"));
    }

    @Test
    void catalogueIsSortedWeightFirstThenName() throws Exception {
        // London carries the highest seed weight (40), so it floats to the top of the picker order.
        mockMvc.perform(get("/api/v1/cities/catalogue").with(user("city-order-user")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].name").value("London"));
    }

    @Test
    void catalogueExcludesRetiredAndInactiveRows() throws Exception {
        insertRow("ZZ Active Extra", true, false);
        insertRow("ZZ Inactive Extra", false, false); // present but not offered (active=false)
        insertRow("ZZ Retired Extra", false, true); // soft-deleted (tombstoned)

        mockMvc.perform(get("/api/v1/cities/catalogue").with(user("city-filter-user")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[?(@.name == 'ZZ Active Extra')]").exists())
                .andExpect(jsonPath("$[?(@.name == 'ZZ Inactive Extra')]").doesNotExist())
                .andExpect(jsonPath("$[?(@.name == 'ZZ Retired Extra')]").doesNotExist());
    }

    @Test
    void adminMayAlsoReadThePublicEndpoint() throws Exception {
        mockMvc.perform(get("/api/v1/cities/catalogue").with(admin("city-admin-read")))
                .andExpect(status().isOk());
    }
}
