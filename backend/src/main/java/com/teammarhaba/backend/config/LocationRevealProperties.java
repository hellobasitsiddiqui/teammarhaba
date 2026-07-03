package com.teammarhaba.backend.config;

import jakarta.validation.constraints.PositiveOrZero;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Config-driven inputs for the event location-reveal policy (TM-408), bound from
 * {@code app.location-reveal.*}. The exact venue of a public event is withheld until
 * {@code now >= start − revealHours}; the number of hours resolves per event in this order
 * (implemented by {@code LocationRevealPolicy}):
 *
 * <ol>
 *   <li>the event's own {@code location_reveal_hours} override (migration V15), else</li>
 *   <li>a per-city default from {@link #cityHours} (keyed on the event's {@code city}), else</li>
 *   <li>the app default {@link #defaultHours}.</li>
 * </ol>
 *
 * <p>These are <strong>tunables, not secrets</strong>: dev/test use the shipped {@value
 * #DEFAULT_HOURS}h default and an empty city map; prod may override either from the environment.
 * City keys are matched case-insensitively (trimmed + lower-cased on both bind and lookup), so
 * {@code "London"}, {@code "london"} and {@code " LONDON "} all hit the same entry.
 *
 * @param defaultHours app-wide reveal window in whole hours, used when neither the event nor its
 *     city supplies one; a {@code null} or negative bind falls back to {@value #DEFAULT_HOURS}.
 * @param cityHours optional per-city reveal windows (city name → whole hours); empty when unset.
 */
@Validated
@ConfigurationProperties(prefix = "app.location-reveal")
public record LocationRevealProperties(
        @PositiveOrZero Integer defaultHours, Map<String, Integer> cityHours) {

    /** The shipped app default: exact location revealed ~24 hours before the event starts. */
    public static final int DEFAULT_HOURS = 24;

    public LocationRevealProperties {
        defaultHours = (defaultHours == null || defaultHours < 0) ? DEFAULT_HOURS : defaultHours;
        cityHours = normalise(cityHours);
    }

    /**
     * The configured per-city reveal window in hours, or {@code null} when the city is unknown /
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
