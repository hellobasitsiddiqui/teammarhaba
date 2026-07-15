package com.teammarhaba.backend.api;

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
 * P2 characterization test (TM-762, part of the TM-738 coverage audit) —
 * {@code adminExpiresLiveAlertClearsForUser}.
 *
 * <p>The existing {@code AlertAdminControllerIntegrationTest.expireNowPullsALiveBannerAndItLeavesTheActiveRead}
 * proves an admin expire pulls the alert out of the active set as seen via the {@code AlertRepository}
 * directly. This test pins the same behaviour end-to-end across BOTH controllers through the real HTTP
 * layer + security chain + Postgres: an admin {@code POST /admin/alerts/{id}/expire} makes the alert
 * vanish from the <b>public, unauthenticated</b> banner read {@code GET /api/v1/alerts/active}
 * ({@link AlertController}) — the read an anonymous visitor actually hits. It verifies the admin write
 * seam and the public read seam resolve against the same server-clock "active" decision, so pulling a
 * live banner really does clear it for users (not just in the repository).
 *
 * <p>All existing behaviour — no source change. Windows are seeded with generous (hour) margins so the
 * real-clock read is stable; the exact edge behaviour is pinned separately in {@code AlertServiceBoundaryTest}.
 */
@AutoConfigureMockMvc
class AlertExpireClearsPublicReadIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AlertRepository alerts;

    @BeforeEach
    void clean() {
        alerts.deleteAll();
    }

    private static RequestPostProcessor admin(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of(new SimpleGrantedAuthority("ROLE_ADMIN"))));
    }

    private Alert seedLive(String message) {
        Instant now = Instant.now();
        return alerts.saveAndFlush(new Alert(
                message,
                AlertLevel.WARNING,
                AlertDismissal.ACKNOWLEDGE,
                now.minus(1, ChronoUnit.HOURS),
                now.plus(1, ChronoUnit.HOURS),
                "seed-admin"));
    }

    @Test
    void adminExpiringALiveAlertClearsItFromThePublicUserRead() throws Exception {
        Alert live = seedLive("Events cancelled due to heat");

        // The public (anonymous, no token) banner read sees the live alert first — the pre-condition.
        mockMvc.perform(get("/api/v1/alerts/active").accept(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].id").value(live.getId()))
                .andExpect(jsonPath("$[0].message").value("Events cancelled due to heat"));

        // An admin pulls it early over HTTP — the derived status flips to EXPIRED.
        mockMvc.perform(post("/api/v1/admin/alerts/{id}/expire", live.getId()).with(admin("ops-admin")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(live.getId()))
                .andExpect(jsonPath("$.status").value("EXPIRED"));

        // The same anonymous public read now returns nothing — the banner is cleared for users.
        mockMvc.perform(get("/api/v1/alerts/active").accept(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(0));
    }
}
