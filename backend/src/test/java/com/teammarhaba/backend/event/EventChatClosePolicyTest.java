package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.config.EventChatCloseProperties;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Unit tests for the {@link EventChatClosePolicy} resolver and its {@link EventChatCloseProperties}
 * config (TM-446) — no Spring context. Pins the three-tier fallback (event override → per-city
 * default → app default), and — the twist that distinguishes this policy from the reveal/cutoff ones
 * — that the <b>app default is "never close"</b>: an unconfigured window resolves to empty, not to a
 * fixed number of hours. Also pins the {@code closesAt = effectiveEnd + hours} arithmetic (the
 * effective end being {@code endAt}, or {@code startAt} for an open-ended event) and the close
 * boundary (closed exactly at the boundary instant, still open a nanosecond before). The end-to-end
 * soft-close + read-only behaviour lives in {@code EventChatLifecycleIntegrationTest}.
 */
class EventChatClosePolicyTest {

    private static final Instant START = Instant.parse("2030-06-15T18:00:00Z");
    private static final Instant END = START.plus(3, ChronoUnit.HOURS); // 21:00

    /** Config: app default "never close" (null), plus a per-city default for London (24h after end). */
    private static EventChatClosePolicy neverDefaultLondon24() {
        return new EventChatClosePolicy(new EventChatCloseProperties(null, Map.of("london", 24)));
    }

    /** Config: an app default of 48h (operator opted the whole app into auto-close), no city entries. */
    private static EventChatClosePolicy appDefault48() {
        return new EventChatClosePolicy(new EventChatCloseProperties(48, Map.of()));
    }

    private static Event event(Integer overrideHours, String city, Instant endAt) {
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
        event.setEndAt(endAt);
        event.setChatCloseHours(overrideHours);
        return event;
    }

    // --- fallback resolution: event → city → app (never) ---

    @Test
    void perEventOverrideWinsOverCityAndAppDefault() {
        assertThat(neverDefaultLondon24().closeHoursFor(event(2, "London", END))).hasValue(2);
    }

    @Test
    void perCityDefaultUsedWhenNoEventOverride() {
        assertThat(neverDefaultLondon24().closeHoursFor(event(null, "London", END))).hasValue(24);
    }

    @Test
    void cityMatchIsCaseAndWhitespaceInsensitive() {
        assertThat(neverDefaultLondon24().closeHoursFor(event(null, "  LONDON  ", END))).hasValue(24);
    }

    @Test
    void neverClosesForUnknownOrMissingCityWhenAppDefaultUnset() {
        // The headline AC default: with nothing configured at any tier, the thread never closes.
        assertThat(neverDefaultLondon24().closeHoursFor(event(null, "Paris", END))).isEmpty();
        assertThat(neverDefaultLondon24().closeHoursFor(event(null, null, END))).isEmpty();
        assertThat(neverDefaultLondon24().closesAt(event(null, null, END))).isEmpty();
        assertThat(neverDefaultLondon24().isClosedAt(event(null, null, END), END.plus(1000, ChronoUnit.DAYS)))
                .isFalse();
    }

    @Test
    void appDefaultUsedWhenOperatorOptsInAndNoOverrideOrCity() {
        assertThat(appDefault48().closeHoursFor(event(null, "Paris", END))).hasValue(48);
        assertThat(appDefault48().closeHoursFor(event(null, null, END))).hasValue(48);
    }

    @Test
    void perEventOverrideOfZeroIsHonoured() {
        // An explicit 0h override means "closes the instant the event ends" — distinct from null/never.
        assertThat(neverDefaultLondon24().closeHoursFor(event(0, "Paris", END))).hasValue(0);
        assertThat(neverDefaultLondon24().closesAt(event(0, "Paris", END))).hasValue(END);
    }

    // --- closesAt arithmetic: measured from the effective end ---

    @Test
    void closesAtIsEndPlusResolvedHours() {
        EventChatClosePolicy policy = neverDefaultLondon24();
        assertThat(policy.closesAt(event(2, "London", END))).hasValue(END.plus(2, ChronoUnit.HOURS));
        assertThat(policy.closesAt(event(null, "London", END))).hasValue(END.plus(24, ChronoUnit.HOURS));
    }

    @Test
    void openEndedEventMeasuresFromStart() {
        // No endAt → the effective end is startAt (an open-ended event closes N hours after it begins).
        assertThat(appDefault48().closesAt(event(null, null, null))).hasValue(START.plus(48, ChronoUnit.HOURS));
    }

    // --- close boundary: just inside / just outside ---

    @Test
    void closedExactlyAtBoundaryAndStillOpenTheInstantBefore() {
        EventChatClosePolicy policy = neverDefaultLondon24();
        Event event = event(2, "London", END); // closes at END + 2h
        Instant boundary = END.plus(2, ChronoUnit.HOURS);

        assertThat(policy.isClosedAt(event, boundary.minusNanos(1)))
                .as("still open a nanosecond before the close instant")
                .isFalse();
        assertThat(policy.isClosedAt(event, boundary))
                .as("closed exactly at now == effectiveEnd + closeHours")
                .isTrue();
        assertThat(policy.isClosedAt(event, boundary.plusSeconds(1))).isTrue();
    }

    // --- properties defaults / hardening ---

    @Test
    void propertiesKeepNullDefaultAsNeverAndRejectNothingSpuriously() {
        // null default stays null (never close) — NOT coerced to a fallback number like the other policies.
        assertThat(new EventChatCloseProperties(null, null).defaultHours()).isNull();
        assertThat(new EventChatCloseProperties(null, null).hoursForCity("london")).isNull();
        assertThat(new EventChatCloseProperties(24, null).defaultHours()).isEqualTo(24);
    }

    @Test
    void propertiesIgnoreBlankAndNegativeCityEntries() {
        Map<String, Integer> raw = new java.util.HashMap<>();
        raw.put("  ", 5); // blank city → dropped
        raw.put("dubai", -1); // negative hours → dropped
        raw.put("cairo", 12);
        EventChatCloseProperties props = new EventChatCloseProperties(null, raw);

        assertThat(props.hoursForCity("cairo")).isEqualTo(12);
        assertThat(props.hoursForCity("dubai")).as("negative hours dropped").isNull();
    }
}
