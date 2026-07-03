package com.teammarhaba.backend.config;

import jakarta.validation.constraints.Positive;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Config-driven inputs for the public event-listing state (TM-412), bound from
 * {@code app.event-listing.*}. It carries the one tunable the "happening now / finished" rule needs:
 * how long an <em>open-ended</em> event (one with no {@code end_at}) is assumed to run before it
 * counts as finished and drops out of the listing.
 *
 * <p><b>Why a default duration.</b> An event that only has a start would otherwise have no moment at
 * which it "ends", so it could either linger in the listing forever or — the opposite failure — be
 * treated as finished the instant it starts. The rule (implemented by {@code EventPhasePolicy}) is:
 * an open-ended event's effective end is {@code start + defaultDuration}, i.e. it stays
 * {@code HAPPENING_NOW} for {@link #defaultDurationHours} hours after it starts, then finishes.
 * Events that <em>do</em> carry an {@code end_at} ignore this value entirely.
 *
 * <p><b>Tunable, not a secret.</b> Dev/test use the shipped {@value #DEFAULT_DURATION_HOURS}h;
 * prod may override via {@code EVENT_DEFAULT_DURATION_HOURS}. The value is a product trade-off:
 * shorter hides finished open-ended events sooner but risks dropping one that is genuinely still
 * running; longer keeps live ones visible but lets ended ones linger. A {@code null}, zero or
 * negative bind falls back to {@value #DEFAULT_DURATION_HOURS} so an open-ended event is never
 * hidden the instant it starts (the AC's explicit guard).
 *
 * @param defaultDurationHours assumed run-length, in whole hours, of an event with no {@code end_at};
 *     falls back to {@value #DEFAULT_DURATION_HOURS} when unset or non-positive.
 */
@Validated
@ConfigurationProperties(prefix = "app.event-listing")
public record EventListingProperties(@Positive Integer defaultDurationHours) {

    /** The shipped app default: an open-ended event is assumed to run ~3 hours (a typical meetup). */
    public static final int DEFAULT_DURATION_HOURS = 3;

    public EventListingProperties {
        defaultDurationHours =
                (defaultDurationHours == null || defaultDurationHours <= 0)
                        ? DEFAULT_DURATION_HOURS
                        : defaultDurationHours;
    }
}
