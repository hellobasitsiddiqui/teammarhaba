package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.alert.Alert;
import com.teammarhaba.backend.alert.AlertDismissal;
import com.teammarhaba.backend.alert.AlertLevel;
import com.teammarhaba.backend.alert.AlertRepository;
import com.teammarhaba.backend.auth.VerifiedUser;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The admin alert API ({@code POST/GET /api/v1/admin/alerts}, {@code POST .../{id}/expire}) — TM-243 —
 * end-to-end through the real security chain + Postgres. Covers the admin-side ACs: ADMIN-only (USER →
 * 403, anon → 401), create attributes {@code createdBy} to the verified token, Bean-Validation
 * {@code 400}s (blank message, missing/ unordered window), the history's derived status
 * (scheduled/active/expired), and expire-now pulling a live banner out of the active set.
 */
@AutoConfigureMockMvc
class AlertAdminControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AlertRepository alerts;

    @BeforeEach
    void clean() {
        alerts.deleteAll();
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

    /** A create body. Any field passed {@code null} is omitted so validation-failure cases can be built. */
    private static String body(String message, String level, String dismissal, Instant startsAt, Instant expiresAt) {
        StringBuilder json = new StringBuilder("{");
        if (message != null) {
            json.append("\"message\":\"").append(message).append("\",");
        }
        if (level != null) {
            json.append("\"level\":\"").append(level).append("\",");
        }
        if (dismissal != null) {
            json.append("\"dismissal\":\"").append(dismissal).append("\",");
        }
        if (startsAt != null) {
            json.append("\"startsAt\":\"").append(startsAt).append("\",");
        }
        if (expiresAt != null) {
            json.append("\"expiresAt\":\"").append(expiresAt).append("\",");
        }
        if (json.charAt(json.length() - 1) == ',') {
            json.setLength(json.length() - 1);
        }
        return json.append("}").toString();
    }

    private Alert seed(String message, Instant startsAt, Instant expiresAt) {
        return alerts.saveAndFlush(
                new Alert(message, AlertLevel.WARNING, AlertDismissal.ACKNOWLEDGE, startsAt, expiresAt, "seed"));
    }

    // --- Authorization -------------------------------------------------------------------------------

    @Test
    void anonymousCreateGetsUniform401() throws Exception {
        mockMvc.perform(post("/api/v1/admin/alerts")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body("Hi", "WARNING", "ACKNOWLEDGE", null, Instant.now().plusSeconds(3600))))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.title").value("Unauthorized"));
    }

    @Test
    void nonAdminCreateGetsUniform403() throws Exception {
        mockMvc.perform(post("/api/v1/admin/alerts")
                        .with(regularUser("plain-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body("Hi", "WARNING", "ACKNOWLEDGE", null, Instant.now().plusSeconds(3600))))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.status").value(403));
    }

    @Test
    void anonymousHistoryGetsUniform401() throws Exception {
        mockMvc.perform(get("/api/v1/admin/alerts")).andExpect(status().isUnauthorized());
    }

    @Test
    void nonAdminHistoryGetsUniform403() throws Exception {
        mockMvc.perform(get("/api/v1/admin/alerts").with(regularUser("plain-user")))
                .andExpect(status().isForbidden());
    }

    // --- Create (201) --------------------------------------------------------------------------------

    @Test
    void adminCreatesAlertAttributedToTheVerifiedCaller() throws Exception {
        Instant start = Instant.now().minus(1, ChronoUnit.HOURS);
        Instant end = Instant.now().plus(1, ChronoUnit.HOURS);

        mockMvc.perform(post("/api/v1/admin/alerts")
                        .with(admin("ops-admin"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body("Events cancelled due to heat", "WARNING", "ACKNOWLEDGE", start, end)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").exists())
                .andExpect(jsonPath("$.message").value("Events cancelled due to heat"))
                .andExpect(jsonPath("$.level").value("WARNING"))
                .andExpect(jsonPath("$.dismissal").value("ACKNOWLEDGE"))
                .andExpect(jsonPath("$.scope").value("global"))
                .andExpect(jsonPath("$.status").value("ACTIVE"))
                // created_by comes from the token, never the body.
                .andExpect(jsonPath("$.createdBy").value("ops-admin"))
                .andExpect(jsonPath("$.createdAt").exists());

        // And it is now visible on the public active read.
        assertThat(alerts.findActive(Alert.SCOPE_GLOBAL, Instant.now())).hasSize(1);
    }

    @Test
    void startsAtDefaultsToNowWhenOmitted() throws Exception {
        mockMvc.perform(post("/api/v1/admin/alerts")
                        .with(admin("ops-admin"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body("Live now", "INFO", "PERSISTENT", null, Instant.now().plus(1, ChronoUnit.HOURS))))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.status").value("ACTIVE"));
    }

    // --- Validation (400) ----------------------------------------------------------------------------

    @Test
    void blankMessageIs400() throws Exception {
        mockMvc.perform(post("/api/v1/admin/alerts")
                        .with(admin("ops-admin"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body("   ", "WARNING", "ACKNOWLEDGE", null, Instant.now().plusSeconds(3600))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));
    }

    @Test
    void missingExpiresAtIs400() throws Exception {
        mockMvc.perform(post("/api/v1/admin/alerts")
                        .with(admin("ops-admin"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body("Hi", "WARNING", "ACKNOWLEDGE", null, null)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[?(@.field=='expiresAt')]").exists());
    }

    @Test
    void unorderedWindowIs400() throws Exception {
        Instant start = Instant.now().plus(2, ChronoUnit.HOURS);
        Instant end = Instant.now().plus(1, ChronoUnit.HOURS); // before start
        mockMvc.perform(post("/api/v1/admin/alerts")
                        .with(admin("ops-admin"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body("Hi", "WARNING", "ACKNOWLEDGE", start, end)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));
    }

    // --- History (derived status) --------------------------------------------------------------------

    @Test
    void historyListsEveryAlertWithItsDerivedStatus() throws Exception {
        Instant now = Instant.now();
        seed("active-one", now.minus(1, ChronoUnit.HOURS), now.plus(1, ChronoUnit.HOURS));
        seed("scheduled-one", now.plus(1, ChronoUnit.HOURS), now.plus(2, ChronoUnit.HOURS));
        seed("expired-one", now.minus(2, ChronoUnit.HOURS), now.minus(1, ChronoUnit.HOURS));

        mockMvc.perform(get("/api/v1/admin/alerts").with(admin("ops-admin")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(3))
                .andExpect(jsonPath("$[?(@.message=='active-one')].status").value("ACTIVE"))
                .andExpect(jsonPath("$[?(@.message=='scheduled-one')].status").value("SCHEDULED"))
                .andExpect(jsonPath("$[?(@.message=='expired-one')].status").value("EXPIRED"));
    }

    // --- Expire-now ----------------------------------------------------------------------------------

    @Test
    void expireNowPullsALiveBannerAndItLeavesTheActiveRead() throws Exception {
        Instant now = Instant.now();
        Alert live = seed("pull-me", now.minus(1, ChronoUnit.HOURS), now.plus(1, ChronoUnit.HOURS));
        assertThat(alerts.findActive(Alert.SCOPE_GLOBAL, Instant.now())).hasSize(1);

        mockMvc.perform(post("/api/v1/admin/alerts/" + live.getId() + "/expire").with(admin("ops-admin")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(live.getId()))
                .andExpect(jsonPath("$.status").value("EXPIRED"));

        assertThat(alerts.findActive(Alert.SCOPE_GLOBAL, Instant.now())).isEmpty();
    }

    @Test
    void expireUnknownIdIs404() throws Exception {
        mockMvc.perform(post("/api/v1/admin/alerts/999999/expire").with(admin("ops-admin")))
                .andExpect(status().isNotFound());
    }
}
