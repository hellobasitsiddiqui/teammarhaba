package com.teammarhaba.backend.event;

import com.teammarhaba.backend.config.CancellationWindowProperties;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import org.springframework.stereotype.Component;

/**
 * The single resolver for an event's <em>cancellation window</em> (TM-414): how many hours before
 * {@code startAt} an un-RSVP starts counting as a late cancellation, when that window opens, and
 * whether a cancel at a given instant falls inside it. It is the one place the fallback order lives,
 * so the un-RSVP path ({@link EventRsvpService#cancelRsvp}) and any future reader agree.
 *
 * <p>Deliberately mirrors {@link LocationRevealPolicy} (TM-408) rather than reinventing a different
 * config mechanism — same <b>fallback order</b>: per-event override
 * ({@link Event#getCancellationWindowHours()}) → per-city default
 * ({@link CancellationWindowProperties#hoursForCity}) → app default
 * ({@link CancellationWindowProperties#defaultHours()}). A {@code null} override means "inherit"; a
 * city with no configured default falls through to the app default. (The two policies are kept as
 * separate types because they answer different questions and are tuned independently; extracting a
 * shared generic resolver is a clean follow-up, left out here to avoid touching TM-408's files.)
 */
@Component
public class CancellationPolicy {

    private final CancellationWindowProperties properties;

    public CancellationPolicy(CancellationWindowProperties properties) {
        this.properties = properties;
    }

    /**
     * The cancellation window for this event in whole hours, resolved override → city → app default.
     */
    public int windowHoursFor(Event event) {
        if (event.getCancellationWindowHours() != null) {
            return event.getCancellationWindowHours();
        }
        Integer cityDefault = properties.hoursForCity(event.getCity());
        return cityDefault != null ? cityDefault : properties.defaultHours();
    }

    /** The instant the late-cancellation window opens: {@code startAt − windowHours}. */
    public Instant windowOpensAt(Event event) {
        return event.getStartAt().minus(windowHoursFor(event), ChronoUnit.HOURS);
    }

    /**
     * Whether cancelling at {@code now} is a <b>late</b> cancellation: {@code true} once
     * {@code now >= startAt − windowHours} (late exactly at the boundary instant, free a nanosecond
     * before). Same boundary convention as {@link LocationRevealPolicy#isRevealed}.
     */
    public boolean isLateCancellation(Event event, Instant now) {
        return !now.isBefore(windowOpensAt(event));
    }
}
