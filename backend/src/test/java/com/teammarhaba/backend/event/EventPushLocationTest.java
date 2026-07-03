package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.config.LocationRevealProperties;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * {@link EventPushLocation} — the shared reveal-aware location line both notify lanes route through
 * (TM-416). Exercised against the real {@link LocationRevealPolicy}/{@link LocationRevealProperties}
 * (shipped 24h default, no per-city rows) so the gate is proven against the actual resolver.
 */
class EventPushLocationTest {

    private static final Instant NOW = Instant.parse("2026-07-03T12:00:00Z");

    private final EventPushLocation pushLocation =
            new EventPushLocation(new LocationRevealPolicy(new LocationRevealProperties(null, Map.of())));

    /** An event starting {@code untilStart} from {@link #NOW}, venue "Marhaba Cafe, 12 High St". */
    private Event eventStartingIn(Duration untilStart) {
        Instant startAt = NOW.plus(untilStart);
        return new Event(
                "Iftar Meetup",
                "desc",
                "Marhaba Cafe, 12 High St",
                "Europe/London",
                startAt,
                startAt.minus(Duration.ofDays(7)),
                startAt.plus(Duration.ofDays(7)),
                9L,
                NOW);
    }

    @Test
    void showsTheVenueOnceRevealed() {
        // Default 24h window; starts in 1h → already past the reveal boundary.
        Event e = eventStartingIn(Duration.ofHours(1));
        assertThat(pushLocation.isRevealed(e, NOW)).isTrue();
        assertThat(pushLocation.line(e, NOW)).isEqualTo("Marhaba Cafe, 12 High St");
    }

    @Test
    void withholdsTheVenueWithHonestCopyBeforeReveal() {
        // Default 24h window; starts in 100 days → not yet revealed.
        Event e = eventStartingIn(Duration.ofDays(100));
        assertThat(pushLocation.isRevealed(e, NOW)).isFalse();
        assertThat(pushLocation.line(e, NOW))
                .isEqualTo("Location shared ~24h before — check the app")
                .doesNotContain("Marhaba Cafe");
    }

    @Test
    void placeholderReflectsAShorterPerEventWindow() {
        // Per-event 2h override; still 100 days out → honest copy names ~2h, not the 24h default.
        Event e = eventStartingIn(Duration.ofDays(100));
        e.setLocationRevealHours(2);
        assertThat(pushLocation.line(e, NOW)).isEqualTo("Location shared ~2h before — check the app");
    }

    @Test
    void revealIsInclusiveAtTheBoundaryInstant() {
        // Exactly at startAt − 24h the venue is public (boundary inclusive, mirrors the resolver).
        Event e = eventStartingIn(Duration.ofHours(24));
        assertThat(pushLocation.isRevealed(e, NOW)).isTrue();
        assertThat(pushLocation.line(e, NOW)).isEqualTo("Marhaba Cafe, 12 High St");
    }

    @Test
    void zeroHourWindowDegradesGracefully() {
        // A 0h reveal window (venue public only at start) → "shortly before", never "~0h".
        Event e = eventStartingIn(Duration.ofHours(5));
        e.setLocationRevealHours(0);
        assertThat(pushLocation.line(e, NOW)).isEqualTo("Location shared shortly before — check the app");
    }
}
