package com.teammarhaba.backend.event;

import com.teammarhaba.backend.config.LocationRevealProperties;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import org.springframework.stereotype.Component;

/**
 * The single resolver for an event's location-reveal window (TM-408): how many hours before
 * {@code startAt} the exact venue becomes public, when that happens, and whether it has happened
 * yet. It is the one place the fallback order lives, so both the public read side
 * ({@link EventQueryService}, which withholds the exact location until reveal) and the admin side
 * ({@code EventResponse}, which surfaces the effective window for the console's prefill) agree.
 *
 * <p><b>Fallback order</b> — per-event override ({@link Event#getLocationRevealHours()}) →
 * per-city default ({@link LocationRevealProperties#hoursForCity}) → app default
 * ({@link LocationRevealProperties#defaultHours()}). A {@code null} override means "inherit"; a
 * city with no configured default falls through to the app default.
 */
@Component
public class LocationRevealPolicy {

    private final LocationRevealProperties properties;

    public LocationRevealPolicy(LocationRevealProperties properties) {
        this.properties = properties;
    }

    /**
     * The reveal window for this event in whole hours, resolved override → city → app default.
     */
    public int revealHoursFor(Event event) {
        if (event.getLocationRevealHours() != null) {
            return event.getLocationRevealHours();
        }
        Integer cityDefault = properties.hoursForCity(event.getCity());
        return cityDefault != null ? cityDefault : properties.defaultHours();
    }

    /** The instant the exact location becomes public: {@code startAt − revealHours}. */
    public Instant revealsAt(Event event) {
        return event.getStartAt().minus(revealHoursFor(event), ChronoUnit.HOURS);
    }

    /**
     * Whether the exact location is public at {@code now}: {@code true} once
     * {@code now >= startAt − revealHours} (revealed exactly at the boundary instant).
     */
    public boolean isRevealed(Event event, Instant now) {
        return !now.isBefore(revealsAt(event));
    }
}
