package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.config.LocationRevealProperties;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Unit tests for the {@link LocationRevealPolicy} resolver and its {@link LocationRevealProperties}
 * config (TM-408) — no Spring context. Pins the fallback order (event override → per-city default →
 * app default), the {@code revealsAt = startAt − hours} arithmetic, and the reveal boundary
 * (revealed exactly at the boundary instant, hidden a nanosecond before). The HTTP-level
 * data-leak guard lives in {@code EventLocationRevealIntegrationTest}.
 */
class LocationRevealPolicyTest {

    private static final Instant START = Instant.parse("2030-06-15T18:00:00Z");

    /** Config: app default 24h, plus a per-city default for London (12h). */
    private static LocationRevealPolicy policyWithLondon12() {
        return new LocationRevealPolicy(new LocationRevealProperties(24, Map.of("london", 12)));
    }

    private static Event event(Integer overrideHours, String city) {
        Event event = new Event(
                "Heading",
                "Body",
                "Marhaba Cafe, 12 High St",
                "Europe/London",
                START,
                START.minus(30, ChronoUnit.DAYS),
                START.plus(1, ChronoUnit.DAYS),
                1L,
                Instant.now());
        event.setCity(city);
        event.setLocationRevealHours(overrideHours);
        return event;
    }

    // --- fallback resolution: event → city → app ---

    @Test
    void perEventOverrideWinsOverCityAndAppDefault() {
        // override 6h beats the London city default (12h) and the app default (24h)
        assertThat(policyWithLondon12().revealHoursFor(event(6, "London"))).isEqualTo(6);
    }

    @Test
    void perCityDefaultUsedWhenNoEventOverride() {
        assertThat(policyWithLondon12().revealHoursFor(event(null, "London"))).isEqualTo(12);
    }

    @Test
    void cityMatchIsCaseAndWhitespaceInsensitive() {
        assertThat(policyWithLondon12().revealHoursFor(event(null, "  LONDON  ")))
                .isEqualTo(12);
    }

    @Test
    void appDefaultUsedForUnknownOrMissingCity() {
        assertThat(policyWithLondon12().revealHoursFor(event(null, "Paris"))).isEqualTo(24);
        assertThat(policyWithLondon12().revealHoursFor(event(null, null))).isEqualTo(24);
    }

    // --- revealsAt arithmetic ---

    @Test
    void revealsAtIsStartMinusResolvedHours() {
        LocationRevealPolicy policy = policyWithLondon12();
        assertThat(policy.revealsAt(event(6, "London"))).isEqualTo(START.minus(6, ChronoUnit.HOURS));
        assertThat(policy.revealsAt(event(null, "London"))).isEqualTo(START.minus(12, ChronoUnit.HOURS));
        assertThat(policy.revealsAt(event(null, null))).isEqualTo(START.minus(24, ChronoUnit.HOURS));
    }

    // --- reveal boundary ---

    @Test
    void revealedExactlyAtBoundaryAndHiddenTheInstantBefore() {
        LocationRevealPolicy policy = policyWithLondon12();
        Event event = event(null, null); // 24h default → reveals at START − 24h
        Instant boundary = START.minus(24, ChronoUnit.HOURS);

        assertThat(policy.isRevealed(event, boundary.minusNanos(1)))
                .as("hidden a nanosecond before the boundary")
                .isFalse();
        assertThat(policy.isRevealed(event, boundary))
                .as("revealed exactly at now == start − revealHours")
                .isTrue();
        assertThat(policy.isRevealed(event, boundary.plusSeconds(1)))
                .as("revealed after the boundary")
                .isTrue();
    }

    // --- properties defaults / hardening ---

    @Test
    void propertiesFallBackToTwentyFourWhenUnsetOrNegative() {
        assertThat(new LocationRevealProperties(null, null).defaultHours()).isEqualTo(24);
        assertThat(new LocationRevealProperties(-5, null).defaultHours()).isEqualTo(24);
        assertThat(new LocationRevealProperties(null, null).hoursForCity("london")).isNull();
    }

    @Test
    void propertiesIgnoreBlankAndNegativeCityEntries() {
        Map<String, Integer> raw = new java.util.HashMap<>();
        raw.put("  ", 5); // blank city → dropped
        raw.put("dubai", -1); // negative hours → dropped
        raw.put("cairo", 8);
        LocationRevealProperties props = new LocationRevealProperties(24, raw);

        assertThat(props.hoursForCity("cairo")).isEqualTo(8);
        assertThat(props.hoursForCity("dubai")).as("negative hours dropped").isNull();
    }
}
