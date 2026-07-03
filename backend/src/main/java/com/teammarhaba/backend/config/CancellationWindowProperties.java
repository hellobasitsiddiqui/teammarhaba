package com.teammarhaba.backend.config;

import jakarta.validation.constraints.PositiveOrZero;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Config-driven inputs for the lightweight cancellation policy (TM-414), bound from
 * {@code app.cancellation-window.*}. An un-RSVP made when {@code now >= start − windowHours} counts
 * as a <em>late cancellation</em> (bumps the user's {@code late_cancel_count}); cancelling earlier
 * is free and silent. The number of hours resolves per event in the same order as the
 * location-reveal window (TM-408) — implemented by {@code CancellationPolicy}:
 *
 * <ol>
 *   <li>the event's own {@code cancellation_window_hours} override (migration V16), else</li>
 *   <li>a per-city default from {@link #cityHours} (keyed on the event's {@code city}), else</li>
 *   <li>the app default {@link #defaultHours}.</li>
 * </ol>
 *
 * <p>Deliberately its <strong>own</strong> config namespace (not shared with
 * {@code app.location-reveal}): the two windows answer different questions — when the venue is
 * revealed vs. when leaving becomes a strike — so an operator must be able to tune them apart. These
 * are <strong>tunables, not secrets</strong>: dev/test use the shipped {@value #DEFAULT_HOURS}h
 * default and an empty city map; prod may override either from the environment. City keys are matched
 * case-insensitively (trimmed + lower-cased on both bind and lookup), so {@code "London"},
 * {@code "london"} and {@code " LONDON "} all hit the same entry.
 *
 * @param defaultHours app-wide cancellation window in whole hours, used when neither the event nor
 *     its city supplies one; a {@code null} or negative bind falls back to {@value #DEFAULT_HOURS}.
 * @param cityHours optional per-city cancellation windows (city name → whole hours); empty when unset.
 */
@Validated
@ConfigurationProperties(prefix = "app.cancellation-window")
public record CancellationWindowProperties(
        @PositiveOrZero Integer defaultHours, Map<String, Integer> cityHours) {

    /** The shipped app default: cancelling within ~24 hours of the start counts as a late cancellation. */
    public static final int DEFAULT_HOURS = 24;

    public CancellationWindowProperties {
        defaultHours = (defaultHours == null || defaultHours < 0) ? DEFAULT_HOURS : defaultHours;
        cityHours = normalise(cityHours);
    }

    /**
     * The configured per-city cancellation window in hours, or {@code null} when the city is unknown /
     * {@code null} — the signal to fall through to {@link #defaultHours}.
     */
    public Integer hoursForCity(String city) {
        return city == null ? null : cityHours.get(city.trim().toLowerCase(Locale.ROOT));
    }

    /** Lower-case + trim keys, drop blank/negative entries, and make the map unmodifiable. */
    private static Map<String, Integer> normalise(Map<String, Integer> raw) {
        if (raw == null || raw.isEmpty()) {
            return Map.of();
        }
        Map<String, Integer> out = new HashMap<>();
        raw.forEach((city, hours) -> {
            if (city != null && !city.isBlank() && hours != null && hours >= 0) {
                out.put(city.trim().toLowerCase(Locale.ROOT), hours);
            }
        });
        return Map.copyOf(out);
    }
}
