package com.teammarhaba.backend.config;

import jakarta.validation.constraints.PositiveOrZero;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Config for the event age-group eligibility guard (TM-415), bound from {@code app.age-gate.*}.
 *
 * <p>An event may target an age band ({@code age_min}/{@code age_max}); a user is eligible iff their
 * self-reported age falls in {@code [age_min − tolerance, age_max + tolerance]}. The tolerance is a
 * single <strong>app-level</strong> constant — deliberately <em>not</em> per-event or per-city, so
 * no admin can weaken the hard rule for one event. {@code AgeEligibilityPolicy} is the sole resolver
 * that reads it.
 *
 * <p>A <strong>tunable, not a secret</strong>: dev/test use the shipped default of {@value
 * #DEFAULT_TOLERANCE_YEARS}; prod may override via the environment. A {@code null} or negative bind
 * falls back to the default (mirrors {@link LocationRevealProperties}), so a misconfiguration can
 * only ever fail safe (never a negative grace).
 *
 * @param toleranceYears the ± grace in whole years applied to each band edge; a {@code null} or
 *     negative value becomes {@value #DEFAULT_TOLERANCE_YEARS}.
 */
@Validated
@ConfigurationProperties(prefix = "app.age-gate")
public record AgeGateProperties(@PositiveOrZero Integer toleranceYears) {

    /** The shipped default grace: ±2 years on each edge of an event's age band. */
    public static final int DEFAULT_TOLERANCE_YEARS = 2;

    public AgeGateProperties {
        toleranceYears =
                (toleranceYears == null || toleranceYears < 0) ? DEFAULT_TOLERANCE_YEARS : toleranceYears;
    }
}
