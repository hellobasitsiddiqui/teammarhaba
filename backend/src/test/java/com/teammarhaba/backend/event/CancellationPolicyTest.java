package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.config.CancellationWindowProperties;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Unit tests for the {@link CancellationPolicy} resolver and its {@link CancellationWindowProperties}
 * config (TM-414) — no Spring context. Pins the fallback order (event override → per-city default →
 * app default), the {@code windowOpensAt = startAt − hours} arithmetic, and the late-cancel boundary
 * (late exactly at the boundary instant, free a nanosecond before). Deliberately mirrors
 * {@code LocationRevealPolicyTest} (TM-408), since the two windows share the layered-resolver pattern.
 */
class CancellationPolicyTest {

    private static final Instant START = Instant.parse("2030-06-15T18:00:00Z");

    /** Config: app default 24h, plus a per-city default for London (12h). */
    private static CancellationPolicy policyWithLondon12() {
        return new CancellationPolicy(new CancellationWindowProperties(24, Map.of("london", 12)));
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
        event.setCancellationWindowHours(overrideHours);
        return event;
    }

    // --- fallback resolution: event → city → app ---

    @Test
    void perEventOverrideWinsOverCityAndAppDefault() {
        // override 6h beats the London city default (12h) and the app default (24h)
        assertThat(policyWithLondon12().windowHoursFor(event(6, "London"))).isEqualTo(6);
    }

    @Test
    void perCityDefaultUsedWhenNoEventOverride() {
        assertThat(policyWithLondon12().windowHoursFor(event(null, "London"))).isEqualTo(12);
    }

    @Test
    void cityMatchIsCaseAndWhitespaceInsensitive() {
        assertThat(policyWithLondon12().windowHoursFor(event(null, "  LONDON  ")))
                .isEqualTo(12);
    }

    @Test
    void appDefaultUsedForUnknownOrMissingCity() {
        assertThat(policyWithLondon12().windowHoursFor(event(null, "Paris"))).isEqualTo(24);
        assertThat(policyWithLondon12().windowHoursFor(event(null, null))).isEqualTo(24);
    }

    // --- windowOpensAt arithmetic ---

    @Test
    void windowOpensAtIsStartMinusResolvedHours() {
        CancellationPolicy policy = policyWithLondon12();
        assertThat(policy.windowOpensAt(event(6, "London"))).isEqualTo(START.minus(6, ChronoUnit.HOURS));
        assertThat(policy.windowOpensAt(event(null, "London"))).isEqualTo(START.minus(12, ChronoUnit.HOURS));
        assertThat(policy.windowOpensAt(event(null, null))).isEqualTo(START.minus(24, ChronoUnit.HOURS));
    }

    // --- late-cancel boundary: just inside / just outside (AC5) ---

    @Test
    void lateExactlyAtBoundaryAndFreeTheInstantBefore() {
        CancellationPolicy policy = policyWithLondon12();
        Event event = event(null, null); // 24h default → window opens at START − 24h
        Instant boundary = START.minus(24, ChronoUnit.HOURS);

        assertThat(policy.isLateCancellation(event, boundary.minusNanos(1)))
                .as("free (not late) a nanosecond before the window opens")
                .isFalse();
        assertThat(policy.isLateCancellation(event, boundary))
                .as("late exactly at now == start − windowHours")
                .isTrue();
        assertThat(policy.isLateCancellation(event, boundary.plusSeconds(1)))
                .as("late once inside the window")
                .isTrue();
    }

    // --- properties defaults / hardening ---

    @Test
    void propertiesFallBackToTwentyFourWhenUnsetOrNegative() {
        assertThat(new CancellationWindowProperties(null, null).defaultHours()).isEqualTo(24);
        assertThat(new CancellationWindowProperties(-5, null).defaultHours()).isEqualTo(24);
        assertThat(new CancellationWindowProperties(null, null).hoursForCity("london")).isNull();
    }

    @Test
    void propertiesIgnoreBlankAndNegativeCityEntries() {
        Map<String, Integer> raw = new java.util.HashMap<>();
        raw.put("  ", 5); // blank city → dropped
        raw.put("dubai", -1); // negative hours → dropped
        raw.put("cairo", 8);
        CancellationWindowProperties props = new CancellationWindowProperties(24, raw);

        assertThat(props.hoursForCity("cairo")).isEqualTo(8);
        assertThat(props.hoursForCity("dubai")).as("negative hours dropped").isNull();
    }
}
