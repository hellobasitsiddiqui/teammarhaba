package com.teammarhaba.backend.security;

import jakarta.validation.constraints.Min;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Tunables for the per-client API rate limiter (TM-158), bound from {@code app.rate-limit.*}.
 *
 * <p>A coarse token-bucket in front of {@code /api/**} that bounds abuse and cheap DoS beyond what
 * Firebase's login lockout covers ({@link RateLimiter} / {@link RateLimitFilter}). Every value has a
 * <strong>safe default</strong> so the base ships throttled out of the box in dev/prod with no extra
 * config, while an operator can tighten (or, in tests, disable) any of them via the environment — the
 * usual {@code .env.example} contract. These are tunables, <em>not secrets</em>.
 *
 * <p>The bucket is classic: a client may spend up to {@code capacity} requests in a burst, and the
 * budget refills by {@code refillTokens} every {@code refillPeriod} (so the sustained rate is
 * {@code refillTokens / refillPeriod}). Numeric bounds are enforced by Bean Validation; the
 * {@link Duration} is validated in the compact constructor (Hibernate Validator has no
 * {@code @Positive} for {@code Duration}), so a missing/non-positive value fails startup loudly
 * rather than silently disabling the guard.
 *
 * <ul>
 *   <li>{@code enabled} — master switch. Default {@code true} so the base is protected by default; the
 *       {@code test} profile sets it {@code false} so the existing integration suite isn't throttled
 *       (mirrors the event-reminders / offer-cascade schedulers), and the dedicated rate-limit test
 *       re-enables it with a tiny budget.</li>
 *   <li>{@code capacity} — burst size: the maximum requests one client may make back-to-back before
 *       the budget must refill (default 120).</li>
 *   <li>{@code refillTokens} — how many tokens are replenished each {@code refillPeriod}; with the
 *       default equal to {@code capacity} this is a plain "N requests per period, burst N" limit
 *       (default 120).</li>
 *   <li>{@code refillPeriod} — the window over which {@code refillTokens} are added back (default 1m,
 *       i.e. the shipped default is 120 requests/minute per client).</li>
 *   <li>{@code maxTrackedClients} — hard cap on how many distinct client keys (uid or IP) the limiter
 *       tracks at once, so the limiter itself can't become a new unbounded map under a spoofed-
 *       {@code X-Forwarded-For} flood (the same DoS the TM-247 review guarded against). The oldest
 *       idle buckets are evicted; a fresh full budget is the worst case (default 100000).</li>
 * </ul>
 */
@Validated
@ConfigurationProperties(prefix = "app.rate-limit")
public record RateLimitProperties(
        Boolean enabled,
        @Min(1) int capacity,
        @Min(1) int refillTokens,
        Duration refillPeriod,
        @Min(1) long maxTrackedClients) {

    public RateLimitProperties {
        // A wrapper Boolean (not primitive) so an ABSENT property defaults to ON: a primitive would
        // bind to false when unset and silently disable the guard — the exact opposite of the intent.
        if (enabled == null) {
            enabled = Boolean.TRUE;
        }
        if (capacity == 0) {
            capacity = 120;
        }
        if (refillTokens == 0) {
            refillTokens = 120;
        }
        refillPeriod = requirePositive(refillPeriod, Duration.ofMinutes(1), "app.rate-limit.refill-period");
        if (maxTrackedClients == 0) {
            maxTrackedClients = 100_000;
        }
    }

    /** Apply the default when unset; reject a present-but-non-positive duration (fail loud). */
    private static Duration requirePositive(Duration value, Duration fallback, String key) {
        if (value == null) {
            return fallback;
        }
        if (value.isZero() || value.isNegative()) {
            throw new IllegalArgumentException(key + " must be a positive duration, but was " + value);
        }
        return value;
    }
}
