package com.teammarhaba.backend.event;

import com.teammarhaba.backend.config.EventListingProperties;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import org.springframework.stereotype.Component;

/**
 * The single resolver for an event's <em>temporal</em> phase (TM-412): whether it is
 * {@link EventPhase#UPCOMING upcoming}, {@link EventPhase#HAPPENING_NOW happening now} or
 * {@link EventPhase#FINISHED finished} at a given instant. It is the one place the
 * "when does an event count as live / ended" rule lives, so the public listing (which surfaces live
 * events and excludes finished ones) and the detail view (which 404s finished events) agree — the
 * same role {@link LocationRevealPolicy} plays for the location-reveal window.
 *
 * <p><b>Effective end.</b> An event with an {@code endAt} ends then. An <em>open-ended</em> event
 * ({@code endAt} is null) is assumed to run for {@link EventListingProperties#defaultDurationHours()}
 * hours, so its effective end is {@code startAt + defaultDuration} — this is what stops an
 * open-ended event either lingering forever or being hidden the instant it starts.
 *
 * <p><b>Boundaries.</b> Live is inclusive of both ends ({@code startAt ≤ now ≤ effectiveEnd},
 * matching the AC "{@code start_at ≤ now ≤ end_at}"); an event is finished only once
 * {@code now > effectiveEnd}. So an event is {@code HAPPENING_NOW} exactly at its start instant and
 * exactly at its end instant, and {@code FINISHED} a nanosecond after the end.
 */
@Component
public class EventPhasePolicy {

    private final EventListingProperties properties;

    public EventPhasePolicy(EventListingProperties properties) {
        this.properties = properties;
    }

    /**
     * The instant this event effectively ends: its {@code endAt}, or — when open-ended —
     * {@code startAt + defaultDuration}. Never null.
     */
    public Instant effectiveEnd(Event event) {
        Instant endAt = event.getEndAt();
        return endAt != null
                ? endAt
                : event.getStartAt().plus(properties.defaultDurationHours(), ChronoUnit.HOURS);
    }

    /** The event's phase at {@code now}: upcoming, happening-now or finished. */
    public EventPhase phaseAt(Event event, Instant now) {
        if (now.isBefore(event.getStartAt())) {
            return EventPhase.UPCOMING;
        }
        return now.isAfter(effectiveEnd(event)) ? EventPhase.FINISHED : EventPhase.HAPPENING_NOW;
    }

    /** Whether the event is live at {@code now} ({@code startAt ≤ now ≤ effectiveEnd}). */
    public boolean isHappeningNow(Event event, Instant now) {
        return phaseAt(event, now) == EventPhase.HAPPENING_NOW;
    }

    /** Whether the event has ended at {@code now} ({@code now > effectiveEnd}). */
    public boolean isFinished(Event event, Instant now) {
        return now.isAfter(effectiveEnd(event));
    }

    /**
     * The {@code startAt} floor for open-ended events in the listing query: an event with no
     * {@code endAt} is <em>not yet finished</em> iff {@code startAt ≥ now − defaultDuration}. Passing
     * this precomputed instant to {@link EventRepository#findVisibleAt} keeps the finished-exclusion
     * as a plain column comparison — no per-row interval arithmetic in JPQL — and consistent with
     * {@link #isFinished}: {@code now > startAt + defaultDuration ⇔ startAt < now − defaultDuration}.
     */
    public Instant openEndedStartFloor(Instant now) {
        return now.minus(properties.defaultDurationHours(), ChronoUnit.HOURS);
    }
}
