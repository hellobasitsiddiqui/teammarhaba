package com.teammarhaba.backend.config;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Tunables for the subscription renewal/dunning engine (TM-620), bound from {@code app.subscriptions.*}
 * and picked up by the app-wide {@code @ConfigurationPropertiesScan}. The scheduler's cadence knobs
 * ({@code enabled} / {@code scan-interval-ms} / {@code initial-delay-ms}) are read directly by
 * {@code SubscriptionRenewalScheduler}'s annotations (the same split every other scheduler uses); this
 * record carries the DUNNING policy the renewal service applies:
 *
 * <ul>
 *   <li>{@code maxRetries} — how many dunning retries a failed renewal gets before the subscription
 *       lapses and the account is downgraded to pay-per-event. With the default 3 (plus the original
 *       attempt) a card problem gets four chances.</li>
 *   <li>{@code retryIntervalHours} — the gap between dunning retries. The default 48h stretches the
 *       3 retries over ~6 days — the "retry over a few days" the product decision asks for.</li>
 * </ul>
 *
 * <p>Tunables, not secrets; blank/invalid values fall back to the shipped defaults so a partial env
 * can never zero-out the grace window.
 *
 * @param maxRetries         dunning retries before the downgrade (default 3; negatives fall back)
 * @param retryIntervalHours hours between dunning retries (default 48; non-positives fall back)
 */
@ConfigurationProperties(prefix = "app.subscriptions")
public record SubscriptionProperties(Integer maxRetries, Integer retryIntervalHours) {

    public SubscriptionProperties {
        maxRetries = maxRetries == null || maxRetries < 0 ? 3 : maxRetries;
        retryIntervalHours = retryIntervalHours == null || retryIntervalHours <= 0 ? 48 : retryIntervalHours;
    }

    /** The dunning retry gap as a {@link Duration} — what the renewal service actually schedules with. */
    public Duration retryInterval() {
        return Duration.ofHours(retryIntervalHours);
    }
}
