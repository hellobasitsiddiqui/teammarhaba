package com.teammarhaba.backend.config;

import jakarta.validation.constraints.PositiveOrZero;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Config-driven inputs for the RSVP booking-cutoff policy (TM-413), bound from
 * {@code app.booking-cutoff.*}. RSVP, waitlist-join and claim are refused once
 * {@code now >= start − cutoffHours}; the number of hours resolves per event in this order
 * (implemented by {@code BookingCutoffPolicy}, using the shared {@link LayeredHours} mechanism —
 * the same three-tier resolver as the location-reveal policy):
 *
 * <ol>
 *   <li>the event's own {@code booking_cutoff_hours} override (migration V16), else</li>
 *   <li>a per-city default from {@link #cityHours} (keyed on the event's {@code city}), else</li>
 *   <li>the app default {@link #defaultHours}.</li>
 * </ol>
 *
 * <p>These are <strong>tunables, not secrets</strong>: dev/test use the shipped {@value
 * #DEFAULT_HOURS}h default and an empty city map; prod may override either from the environment.
 * City keys are matched case-insensitively (trimmed + lower-cased on both bind and lookup), so
 * {@code "London"}, {@code "london"} and {@code " LONDON "} all hit the same entry.
 *
 * @param defaultHours app-wide cutoff window in whole hours, used when neither the event nor its
 *     city supplies one; a {@code null} or negative bind falls back to {@value #DEFAULT_HOURS}.
 * @param cityHours optional per-city cutoff windows (city name → whole hours); empty when unset.
 */
@Validated
@ConfigurationProperties(prefix = "app.booking-cutoff")
public record BookingCutoffProperties(
        @PositiveOrZero Integer defaultHours, Map<String, Integer> cityHours) {

    /** The shipped app default: bookings close 1 hour before the event starts. */
    public static final int DEFAULT_HOURS = 1;

    public BookingCutoffProperties {
        defaultHours = LayeredHours.defaultOrFallback(defaultHours, DEFAULT_HOURS);
        cityHours = LayeredHours.normalizeCityHours(cityHours);
    }

    /**
     * The configured per-city cutoff window in hours, or {@code null} when the city is unknown /
     * {@code null} — the signal to fall through to {@link #defaultHours}.
     */
    public Integer hoursForCity(String city) {
        return LayeredHours.cityValue(cityHours, city);
    }
}
