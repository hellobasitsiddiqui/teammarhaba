package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.config.BookingCutoffProperties;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Unit tests for the {@link BookingCutoffPolicy} resolver and its {@link BookingCutoffProperties}
 * config (TM-413) — no Spring context. Pins the fallback order (event override → per-city default →
 * app default of 1h), the {@code cutoffAt = startAt − hours} arithmetic, and the cutoff boundary
 * (closed exactly at the boundary instant, still open a nanosecond before). The service-level
 * enforcement of the 409 lives in {@code EventRsvpEligibilityIntegrationTest}.
 */
class BookingCutoffPolicyTest {

    private static final Instant START = Instant.parse("2030-06-15T18:00:00Z");

    /** Config: app default 1h, plus a per-city default for London (2h). */
    private static BookingCutoffPolicy policyWithLondon2() {
        return new BookingCutoffPolicy(new BookingCutoffProperties(1, Map.of("london", 2)));
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
        event.setBookingCutoffHours(overrideHours);
        return event;
    }

    // --- fallback resolution: event → city → app ---

    @Test
    void perEventOverrideWinsOverCityAndAppDefault() {
        // override 4h beats the London city default (2h) and the app default (1h)
        assertThat(policyWithLondon2().cutoffHoursFor(event(4, "London"))).isEqualTo(4);
    }

    @Test
    void perCityDefaultUsedWhenNoEventOverride() {
        assertThat(policyWithLondon2().cutoffHoursFor(event(null, "London"))).isEqualTo(2);
    }

    @Test
    void cityMatchIsCaseAndWhitespaceInsensitive() {
        assertThat(policyWithLondon2().cutoffHoursFor(event(null, "  LONDON  "))).isEqualTo(2);
    }

    @Test
    void appDefaultUsedForUnknownOrMissingCity() {
        assertThat(policyWithLondon2().cutoffHoursFor(event(null, "Paris"))).isEqualTo(1);
        assertThat(policyWithLondon2().cutoffHoursFor(event(null, null))).isEqualTo(1);
    }

    @Test
    void perEventOverrideOfZeroIsHonoured() {
        // an explicit 0h override means "bookable right up to the start" — distinct from null/inherit
        assertThat(policyWithLondon2().cutoffHoursFor(event(0, "London"))).isZero();
    }

    // --- cutoffAt arithmetic ---

    @Test
    void cutoffAtIsStartMinusResolvedHours() {
        BookingCutoffPolicy policy = policyWithLondon2();
        assertThat(policy.cutoffAt(event(4, "London"))).isEqualTo(START.minus(4, ChronoUnit.HOURS));
        assertThat(policy.cutoffAt(event(null, "London"))).isEqualTo(START.minus(2, ChronoUnit.HOURS));
        assertThat(policy.cutoffAt(event(null, null))).isEqualTo(START.minus(1, ChronoUnit.HOURS));
    }

    // --- cutoff boundary: just inside / just outside the 1h window ---

    @Test
    void closedExactlyAtBoundaryAndStillOpenTheInstantBefore() {
        BookingCutoffPolicy policy = policyWithLondon2();
        Event event = event(null, null); // 1h default → closes at START − 1h
        Instant boundary = START.minus(1, ChronoUnit.HOURS);

        assertThat(policy.isPastCutoff(event, boundary.minusNanos(1)))
                .as("just outside: still bookable a nanosecond before the 1h mark")
                .isFalse();
        assertThat(policy.isPastCutoff(event, boundary))
                .as("closed exactly at now == start − cutoffHours")
                .isTrue();
        assertThat(policy.isPastCutoff(event, boundary.plusSeconds(1)))
                .as("just inside: closed within the last hour")
                .isTrue();
    }

    // --- properties defaults / hardening ---

    @Test
    void propertiesFallBackToOneWhenUnsetOrNegative() {
        assertThat(new BookingCutoffProperties(null, null).defaultHours()).isEqualTo(1);
        assertThat(new BookingCutoffProperties(-5, null).defaultHours()).isEqualTo(1);
        assertThat(new BookingCutoffProperties(null, null).hoursForCity("london")).isNull();
    }

    @Test
    void propertiesIgnoreBlankAndNegativeCityEntries() {
        Map<String, Integer> raw = new java.util.HashMap<>();
        raw.put("  ", 5); // blank city → dropped
        raw.put("dubai", -1); // negative hours → dropped
        raw.put("cairo", 3);
        BookingCutoffProperties props = new BookingCutoffProperties(1, raw);

        assertThat(props.hoursForCity("cairo")).isEqualTo(3);
        assertThat(props.hoursForCity("dubai")).as("negative hours dropped").isNull();
    }
}
