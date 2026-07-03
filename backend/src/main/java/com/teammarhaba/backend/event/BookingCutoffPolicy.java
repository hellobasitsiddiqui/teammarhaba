package com.teammarhaba.backend.event;

import com.teammarhaba.backend.config.BookingCutoffProperties;
import com.teammarhaba.backend.config.LayeredHours;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import org.springframework.stereotype.Component;

/**
 * The single resolver for an event's booking cutoff (TM-413): how many hours before {@code startAt}
 * the event stops accepting new joins, when that boundary is, and whether it has passed. It mirrors
 * {@link LocationRevealPolicy} and shares the same three-tier fallback via {@link LayeredHours}, so
 * the layered-config logic is written once.
 *
 * <p><b>Fallback order</b> — per-event override ({@link Event#getBookingCutoffHours()}) → per-city
 * default ({@link BookingCutoffProperties#hoursForCity}) → app default
 * ({@link BookingCutoffProperties#defaultHours()}, shipped 1h). A {@code null} override means
 * "inherit"; a city with no configured default falls through to the app default.
 *
 * <p>Enforcement lives in {@link EventRsvpService}: RSVP, waitlist-join and claim are refused with a
 * {@code 409} once {@link #isPastCutoff} is true. Leaving (un-RSVP) is never gated by the cutoff —
 * an attendee can always drop out.
 */
@Component
public class BookingCutoffPolicy {

    private final BookingCutoffProperties properties;

    public BookingCutoffPolicy(BookingCutoffProperties properties) {
        this.properties = properties;
    }

    /**
     * The cutoff window for this event in whole hours, resolved override → city → app default.
     */
    public int cutoffHoursFor(Event event) {
        return LayeredHours.resolve(
                event.getBookingCutoffHours(), properties.hoursForCity(event.getCity()), properties.defaultHours());
    }

    /** The instant new joins stop being accepted: {@code startAt − cutoffHours}. */
    public Instant cutoffAt(Event event) {
        return event.getStartAt().minus(cutoffHoursFor(event), ChronoUnit.HOURS);
    }

    /**
     * Whether booking has closed at {@code now}: {@code true} once
     * {@code now >= startAt − cutoffHours} (closed exactly at the boundary instant, still open a
     * nanosecond before). Mirrors {@link LocationRevealPolicy#isRevealed}'s boundary semantics.
     */
    public boolean isPastCutoff(Event event, Instant now) {
        return !now.isBefore(cutoffAt(event));
    }
}
