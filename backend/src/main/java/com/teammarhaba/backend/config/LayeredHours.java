package com.teammarhaba.backend.config;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * The shared "layered hours" configuration mechanism behind every per-event → per-city → app-default
 * whole-hour policy. Introduced for the location-reveal policy (TM-408) and reused by the
 * booking-cutoff policy (TM-413): both resolve an hour window in the same three-tier order and
 * normalise their per-city maps identically, so that logic lives here <em>once</em> rather than
 * being copied per feature (the "reuse the resolver, don't duplicate the config logic" rule).
 *
 * <p>Two collaborators use it:
 *
 * <ul>
 *   <li>the {@code @ConfigurationProperties} record (e.g. {@link LocationRevealProperties},
 *       {@link BookingCutoffProperties}) calls {@link #defaultOrFallback} and
 *       {@link #normalizeCityHours} in its compact constructor and {@link #cityValue} in its
 *       per-city lookup;</li>
 *   <li>the resolver {@code @Component} (e.g. {@code LocationRevealPolicy},
 *       {@code BookingCutoffPolicy}) calls {@link #resolve} to collapse the three tiers to one
 *       number.</li>
 * </ul>
 */
public final class LayeredHours {

    private LayeredHours() {
    }

    /** An app-default bind of {@code null} or a negative number falls back to {@code fallback}. */
    public static int defaultOrFallback(Integer configured, int fallback) {
        return (configured == null || configured < 0) ? fallback : configured;
    }

    /**
     * Collapse the three tiers to a single whole-hour window: a non-null per-event {@code override}
     * wins; otherwise a non-null per-city {@code cityDefault}; otherwise the {@code appDefault}. A
     * {@code null} override means "inherit"; a city with no configured default falls through to the
     * app default.
     */
    public static int resolve(Integer override, Integer cityDefault, int appDefault) {
        if (override != null) {
            return override;
        }
        return cityDefault != null ? cityDefault : appDefault;
    }

    /**
     * The configured per-city hours for {@code city}, or {@code null} when the city is {@code null}
     * or absent — the signal to fall through to the app default. Keys are matched case- and
     * whitespace-insensitively (trimmed + lower-cased), mirroring {@link #normalizeCityHours}.
     */
    public static Integer cityValue(Map<String, Integer> normalizedCityHours, String city) {
        return city == null ? null : normalizedCityHours.get(city.trim().toLowerCase(Locale.ROOT));
    }

    /**
     * Lower-case + trim keys, drop blank-city or negative-hour entries, and return an unmodifiable
     * copy — so the bound map is safe to share and lookups are case-insensitive. A {@code null} or
     * empty input yields an empty map.
     */
    public static Map<String, Integer> normalizeCityHours(Map<String, Integer> raw) {
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
