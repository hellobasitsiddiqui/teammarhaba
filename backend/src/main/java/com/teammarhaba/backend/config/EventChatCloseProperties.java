package com.teammarhaba.backend.config;

import jakarta.validation.constraints.PositiveOrZero;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Config-driven inputs for the event group-chat close/lock policy (TM-446), bound from
 * {@code app.event-chat-close.*}. An event's group chat auto-closes (goes read-only) a number of
 * whole hours <em>after</em> the event ends; that number resolves per event in this order
 * (implemented by {@code EventChatClosePolicy}, using the shared {@link LayeredHours} mechanism —
 * the same three-tier resolver as the location-reveal (TM-408) and booking-cutoff (TM-413) policies):
 *
 * <ol>
 *   <li>the event's own {@code chat_close_hours} override (migration V29), else</li>
 *   <li>a per-city default from {@link #cityHours} (keyed on the event's {@code city}), else</li>
 *   <li>the app default {@link #defaultHours}.</li>
 * </ol>
 *
 * <p><b>The app default is deliberately "never close".</b> Unlike the reveal/cutoff policies —
 * whose app default is a fixed number of hours — this record does <em>not</em> fall back to a
 * constant when {@link #defaultHours} is unbound: a {@code null} {@code defaultHours} (nothing
 * configured at any tier) means the thread never auto-closes at all. Operators opt in to a close
 * window by setting {@code default-hours} (or a per-city entry); the shipped config leaves it unset.
 *
 * <p>These are <strong>tunables, not secrets</strong>: dev/test/prod ship with an unset default
 * (never close) and an empty city map; prod may set either from the environment. City keys are
 * matched case-insensitively (trimmed + lower-cased on both bind and lookup), so {@code "London"},
 * {@code "london"} and {@code " LONDON "} all hit the same entry.
 *
 * @param defaultHours app-wide close window in whole hours after the event ends, used when neither
 *     the event nor its city supplies one; {@code null} (the shipped value) = <b>never close</b>.
 *     A negative bind is rejected by {@code @PositiveOrZero}.
 * @param cityHours optional per-city close windows (city name → whole hours after end); empty when
 *     unset. A city with no entry falls through to {@link #defaultHours}.
 */
@Validated
@ConfigurationProperties(prefix = "app.event-chat-close")
public record EventChatCloseProperties(
        @PositiveOrZero Integer defaultHours, Map<String, Integer> cityHours) {

    public EventChatCloseProperties {
        // Intentionally NO defaultOrFallback here: a null defaultHours must stay null so the policy
        // reads "never close". Only the per-city map is normalised (trim/lower-case keys, drop blank
        // cities and negative hours), shared with every other layered-hours policy.
        cityHours = LayeredHours.normalizeCityHours(cityHours);
    }

    /**
     * The configured per-city close window in hours, or {@code null} when the city is unknown /
     * {@code null} — the signal to fall through to {@link #defaultHours} (and, if that is also
     * {@code null}, to "never close").
     */
    public Integer hoursForCity(String city) {
        return LayeredHours.cityValue(cityHours, city);
    }
}
