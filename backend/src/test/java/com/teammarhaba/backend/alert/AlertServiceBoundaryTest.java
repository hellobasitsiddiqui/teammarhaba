package com.teammarhaba.backend.alert;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * Active-window filtering AT THE BOUNDARIES (TM-243), exercised against real Postgres but a FROZEN
 * clock so the edges are exact and deterministic. Builds its own {@link AlertService} over the
 * autowired repository with a {@link Clock#fixed} instant (the house Clock seam) — this is the AC's
 * "server decides active" made precise: {@code startsAt} is inclusive, {@code expiresAt} exclusive.
 *
 * <p>The frozen instant is truncated to microseconds so it round-trips through the {@code TIMESTAMPTZ}
 * columns exactly (Postgres keeps microsecond precision), letting the "exactly at the edge" rows test
 * the boundary rather than a sub-tick approximation.
 */
class AlertServiceBoundaryTest extends AbstractIntegrationTest {

    /** The frozen "now" every activeness question resolves against. Micros so the DB round-trip is exact. */
    private static final Instant NOW = Instant.parse("2026-07-09T12:00:00Z").truncatedTo(ChronoUnit.MICROS);

    @Autowired
    private AlertRepository repo;

    private AlertService serviceAt(Instant now) {
        return new AlertService(repo, Clock.fixed(now, ZoneOffset.UTC));
    }

    private Alert seed(String message, Instant startsAt, Instant expiresAt) {
        return repo.saveAndFlush(
                new Alert(message, AlertLevel.WARNING, AlertDismissal.ACKNOWLEDGE, startsAt, expiresAt, "seed-admin"));
    }

    @Test
    void activeReadHonoursTheHalfOpenWindowAtTheEdges() {
        // ACTIVE — starts exactly AT now (inclusive edge).
        Alert atStart = seed("at-start", NOW, NOW.plus(1, ChronoUnit.HOURS));
        // ACTIVE — comfortably inside the window.
        Alert inside = seed("inside", NOW.minus(1, ChronoUnit.HOURS), NOW.plus(1, ChronoUnit.HOURS));
        // EXPIRED — expires exactly AT now (exclusive edge): must NOT be active.
        seed("at-expiry", NOW.minus(2, ChronoUnit.HOURS), NOW);
        // SCHEDULED — starts one second after now: must NOT be active.
        seed("scheduled", NOW.plusSeconds(1), NOW.plus(2, ChronoUnit.HOURS));
        // EXPIRED — wholly in the past.
        seed("past", NOW.minus(2, ChronoUnit.HOURS), NOW.minus(1, ChronoUnit.HOURS));

        List<Alert> active = serviceAt(NOW).activeGlobal();

        assertThat(active).extracting(Alert::getMessage).containsExactlyInAnyOrder("at-start", "inside");
        // And the derived status agrees with the read at each edge.
        assertThat(atStart.status(NOW)).isEqualTo(AlertStatus.ACTIVE);
        assertThat(inside.status(NOW)).isEqualTo(AlertStatus.ACTIVE);
    }

    @Test
    void expireNowPullsALiveBannerOutOfTheActiveSet() {
        Alert live = seed("live", NOW.minus(1, ChronoUnit.HOURS), NOW.plus(1, ChronoUnit.HOURS));
        assertThat(serviceAt(NOW).activeGlobal()).extracting(Alert::getId).contains(live.getId());

        Alert expired = serviceAt(NOW).expireNow(live.getId());

        // Its expiry was brought forward to exactly now, so it is no longer active and reads EXPIRED.
        assertThat(expired.getExpiresAt()).isEqualTo(NOW);
        assertThat(expired.status(NOW)).isEqualTo(AlertStatus.EXPIRED);
        assertThat(serviceAt(NOW).activeGlobal()).extracting(Alert::getId).doesNotContain(live.getId());
    }

    @Test
    void reExpiringAnAlreadyExpiredAlertKeepsItsOriginalEnd() {
        Instant originalEnd = NOW.minus(1, ChronoUnit.HOURS);
        Alert past = seed("already-expired", NOW.minus(2, ChronoUnit.HOURS), originalEnd);

        Alert reExpired = serviceAt(NOW).expireNow(past.getId());

        // expire-now only ever moves the expiry EARLIER — a past alert keeps its true end (honest history).
        assertThat(reExpired.getExpiresAt()).isEqualTo(originalEnd);
    }
}
