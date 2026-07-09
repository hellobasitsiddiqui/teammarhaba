package com.teammarhaba.backend.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.alert.Alert;
import com.teammarhaba.backend.alert.AlertDismissal;
import com.teammarhaba.backend.alert.AlertLevel;
import com.teammarhaba.backend.alert.AlertRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/**
 * The public alert-banner read {@code GET /api/v1/alerts/active} (TM-243) end-to-end through the real
 * security chain + Postgres. Covers the ACs on the read side:
 *
 * <ul>
 *   <li><b>Public</b> — reachable with NO token (a warning can show pre-login), unlike the rest of the
 *       default-deny {@code /api/v1} surface.
 *   <li><b>Active-window filtering</b> — a scheduled (future) and an expired (past) alert are hidden;
 *       only the currently-active one is returned.
 *   <li><b>Minimal public shape</b> — only {@code id/message/level/dismissal}; the actor
 *       ({@code createdBy}), scope and schedule are NOT leaked to the anonymous read.
 * </ul>
 *
 * Windows are seeded relative to {@code Instant.now()} with generous (hour) margins so the real-clock
 * read is stable; the exact edge behaviour is pinned separately with a frozen clock in
 * {@code AlertServiceBoundaryTest}.
 */
@AutoConfigureMockMvc
class AlertControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AlertRepository alerts;

    @BeforeEach
    void clean() {
        alerts.deleteAll();
    }

    private Alert seed(String message, AlertLevel level, Instant startsAt, Instant expiresAt) {
        return alerts.saveAndFlush(new Alert(message, level, AlertDismissal.ACKNOWLEDGE, startsAt, expiresAt, "op-uid"));
    }

    @Test
    void publicReadReturnsOnlyActiveAlertsWithoutAToken() throws Exception {
        Instant now = Instant.now();
        seed("Events cancelled due to heat", AlertLevel.WARNING, now.minus(1, ChronoUnit.HOURS), now.plus(1, ChronoUnit.HOURS));
        seed("Upcoming maintenance", AlertLevel.INFO, now.plus(1, ChronoUnit.HOURS), now.plus(2, ChronoUnit.HOURS)); // scheduled
        seed("Old outage", AlertLevel.CRITICAL, now.minus(2, ChronoUnit.HOURS), now.minus(1, ChronoUnit.HOURS)); // expired

        // No .with(...) principal at all — the request is anonymous, and must still succeed (200).
        mockMvc.perform(get("/api/v1/alerts/active").accept(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].message").value("Events cancelled due to heat"))
                .andExpect(jsonPath("$[0].level").value("WARNING"))
                .andExpect(jsonPath("$[0].dismissal").value("ACKNOWLEDGE"))
                .andExpect(jsonPath("$[0].id").exists())
                // The public shape must NOT leak the actor / scope / schedule.
                .andExpect(jsonPath("$[0].createdBy").doesNotExist())
                .andExpect(jsonPath("$[0].scope").doesNotExist())
                .andExpect(jsonPath("$[0].startsAt").doesNotExist())
                .andExpect(jsonPath("$[0].createdAt").doesNotExist());
    }

    @Test
    void emptyWhenNothingIsActive() throws Exception {
        Instant now = Instant.now();
        seed("Later", AlertLevel.INFO, now.plus(1, ChronoUnit.HOURS), now.plus(2, ChronoUnit.HOURS));

        mockMvc.perform(get("/api/v1/alerts/active").accept(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(0));
    }
}
