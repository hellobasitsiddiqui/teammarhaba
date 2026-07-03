package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.config.EventListingProperties;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import org.junit.jupiter.api.Test;

/**
 * Unit tests for the {@link EventPhasePolicy} resolver and its {@link EventListingProperties} config
 * (TM-412) — no Spring context. Pins the three boundaries (upcoming / happening-now / just-finished),
 * the inclusive live window ({@code start ≤ now ≤ effectiveEnd}), the open-ended default duration
 * (effective end {@code = start + defaultDuration}) and its explicit "not hidden the instant it
 * starts" guard, plus the open-ended query floor. The HTTP-level behaviour (listing surfaces live /
 * hides finished, detail 404s finished) lives in {@code EventListingStateIntegrationTest}.
 */
class EventPhasePolicyTest {

    private static final Instant START = Instant.parse("2030-06-15T18:00:00Z");
    private static final Instant END = START.plus(2, ChronoUnit.HOURS); // explicit end, 2h after start

    /** Default policy: open-ended events assumed to run {@value EventListingProperties#DEFAULT_DURATION_HOURS}h. */
    private static EventPhasePolicy policy() {
        return new EventPhasePolicy(new EventListingProperties(EventListingProperties.DEFAULT_DURATION_HOURS));
    }

    private static Event event(Instant startAt, Instant endAt) {
        Event event = new Event(
                "Heading",
                "Body",
                "Marhaba Cafe, 12 High St",
                "Europe/London",
                startAt,
                startAt.minus(1, ChronoUnit.DAYS),
                startAt.plus(1, ChronoUnit.DAYS),
                1L,
                Instant.now());
        event.setEndAt(endAt);
        return event;
    }

    // --- effective end ---

    @Test
    void effectiveEndIsEndAtWhenSet() {
        assertThat(policy().effectiveEnd(event(START, END))).isEqualTo(END);
    }

    @Test
    void effectiveEndIsStartPlusDefaultDurationWhenOpenEnded() {
        assertThat(policy().effectiveEnd(event(START, null)))
                .isEqualTo(START.plus(EventListingProperties.DEFAULT_DURATION_HOURS, ChronoUnit.HOURS));
    }

    @Test
    void effectiveEndHonoursAConfiguredDefaultDuration() {
        EventPhasePolicy sixHour = new EventPhasePolicy(new EventListingProperties(6));
        assertThat(sixHour.effectiveEnd(event(START, null))).isEqualTo(START.plus(6, ChronoUnit.HOURS));
    }

    // --- the three boundaries (explicit end) ---

    @Test
    void phaseIsUpcomingBeforeStart() {
        assertThat(policy().phaseAt(event(START, END), START.minusNanos(1))).isEqualTo(EventPhase.UPCOMING);
    }

    @Test
    void phaseIsHappeningNowAcrossTheInclusiveLiveWindow() {
        EventPhasePolicy policy = policy();
        Event event = event(START, END);
        assertThat(policy.phaseAt(event, START)).as("live exactly at start").isEqualTo(EventPhase.HAPPENING_NOW);
        assertThat(policy.phaseAt(event, START.plus(1, ChronoUnit.HOURS)))
                .as("live mid-event")
                .isEqualTo(EventPhase.HAPPENING_NOW);
        assertThat(policy.phaseAt(event, END)).as("live exactly at end").isEqualTo(EventPhase.HAPPENING_NOW);
    }

    @Test
    void phaseIsFinishedTheInstantAfterEnd() {
        EventPhasePolicy policy = policy();
        Event event = event(START, END);
        assertThat(policy.phaseAt(event, END.plusNanos(1)))
                .as("finished a nanosecond after end")
                .isEqualTo(EventPhase.FINISHED);
        assertThat(policy.phaseAt(event, END.plusSeconds(1))).isEqualTo(EventPhase.FINISHED);
    }

    // --- null end_at default ---

    @Test
    void openEndedIsHappeningNowThroughTheDefaultWindowThenFinished() {
        EventPhasePolicy policy = policy();
        Event event = event(START, null); // effective end = START + 3h
        Instant effectiveEnd = START.plus(EventListingProperties.DEFAULT_DURATION_HOURS, ChronoUnit.HOURS);

        assertThat(policy.phaseAt(event, START.plus(1, ChronoUnit.HOURS)))
                .as("still live an hour into an open-ended event")
                .isEqualTo(EventPhase.HAPPENING_NOW);
        assertThat(policy.phaseAt(event, effectiveEnd))
                .as("live exactly at the assumed end")
                .isEqualTo(EventPhase.HAPPENING_NOW);
        assertThat(policy.phaseAt(event, effectiveEnd.plusNanos(1)))
                .as("finished once past the assumed duration")
                .isEqualTo(EventPhase.FINISHED);
    }

    @Test
    void openEndedEventIsNotHiddenTheInstantItStarts() {
        // AC2 guard: an event with no end must not count as finished the moment it begins.
        EventPhasePolicy policy = policy();
        Event event = event(START, null);
        assertThat(policy.phaseAt(event, START)).isEqualTo(EventPhase.HAPPENING_NOW);
        assertThat(policy.isFinished(event, START)).isFalse();
    }

    // --- helpers agree with phase ---

    @Test
    void isHappeningNowAndIsFinishedTrackThePhase() {
        EventPhasePolicy policy = policy();
        Event event = event(START, END);
        assertThat(policy.isHappeningNow(event, START)).isTrue();
        assertThat(policy.isFinished(event, START)).isFalse();
        assertThat(policy.isHappeningNow(event, END.plusSeconds(1))).isFalse();
        assertThat(policy.isFinished(event, END.plusSeconds(1))).isTrue();
        assertThat(policy.isHappeningNow(event, START.minusSeconds(1))).as("upcoming is not live").isFalse();
    }

    // --- open-ended query floor ---

    @Test
    void openEndedStartFloorIsNowMinusDefaultDuration() {
        Instant now = Instant.parse("2030-06-15T20:00:00Z");
        assertThat(policy().openEndedStartFloor(now))
                .isEqualTo(now.minus(EventListingProperties.DEFAULT_DURATION_HOURS, ChronoUnit.HOURS));
        assertThat(new EventPhasePolicy(new EventListingProperties(6)).openEndedStartFloor(now))
                .isEqualTo(now.minus(6, ChronoUnit.HOURS));
    }

    // --- properties hardening ---

    @Test
    void defaultDurationFallsBackWhenUnsetOrNonPositive() {
        assertThat(new EventListingProperties(null).defaultDurationHours()).isEqualTo(3);
        assertThat(new EventListingProperties(0).defaultDurationHours()).isEqualTo(3);
        assertThat(new EventListingProperties(-2).defaultDurationHours()).isEqualTo(3);
        assertThat(new EventListingProperties(5).defaultDurationHours()).isEqualTo(5);
    }
}
