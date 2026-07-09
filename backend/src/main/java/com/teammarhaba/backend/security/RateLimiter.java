package com.teammarhaba.backend.security;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.teammarhaba.backend.auth.VerifiedUser;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Duration;
import java.util.function.LongSupplier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

/**
 * Per-client token-bucket rate limiter for the API (TM-158). Each caller gets a bucket keyed by their
 * authenticated Firebase {@code uid} when present, else by client IP — so an authenticated abuser is
 * throttled per-account (surviving IP rotation) and anonymous traffic is throttled per-source. A
 * request is allowed while the bucket has a token; once empty it is refused until the budget refills
 * (see {@link RateLimitProperties} for the numbers). {@link RateLimitFilter} turns a refusal into an
 * RFC 7807 {@code 429} with {@code Retry-After}.
 *
 * <p><strong>Bounded by construction.</strong> Buckets live in a Caffeine cache that is
 * {@linkplain Caffeine#maximumSize size-capped} at {@link RateLimitProperties#maxTrackedClients()} and
 * {@linkplain Caffeine#expireAfterAccess evicts} a client idle for the <em>full-refill horizon</em>
 * ({@code capacity/refillTokens x refillPeriod} — see {@link #fullRefillHorizon}). That cap is the
 * critical bit: it stops the limiter from itself becoming a new unbounded map when an attacker rotates
 * a spoofed {@code X-Forwarded-For} (the unbounded-map DoS the TM-247 review found). Worst case the
 * oldest idle buckets are evicted and those clients get a fresh (already fully-refilled) budget; memory
 * stays bounded. The horizon (not the bare refill period) is the eviction TTL precisely so a recreated
 * full bucket only ever appears once idling that long <em>would</em> have refilled it to capacity
 * anyway — otherwise a burst&gt;sustained config would leak a free full burst on eviction (TM-571).
 *
 * <p><strong>Process-local</strong>, like the email-code limiter (TM-247): fine for a single Cloud Run
 * instance, and the per-instance rate simply multiplies by the instance count. A shared store (Redis)
 * or an edge rule (Cloud Armor) is the future improvement for a strict global limit across instances.
 */
@Component
public class RateLimiter {

    static final String FORWARDED_FOR_HEADER = "X-Forwarded-For";

    private final RateLimitProperties props;
    /** Monotonic clock in nanoseconds; overridable in tests to drive refill deterministically. */
    private final LongSupplier nanoClock;
    /** Tokens replenished per nanosecond — the sustained refill rate, precomputed once. */
    private final double refillPerNano;
    private final double capacity;
    private final Cache<String, TokenBucket> buckets;

    @Autowired
    public RateLimiter(RateLimitProperties props) {
        this(props, System::nanoTime);
    }

    /** Test seam: an advanceable nano-clock drives the bucket refill deterministically. */
    RateLimiter(RateLimitProperties props, LongSupplier nanoClock) {
        this.props = props;
        this.nanoClock = nanoClock;
        this.capacity = props.capacity();
        this.refillPerNano = (double) props.refillTokens() / props.refillPeriod().toNanos();
        this.buckets = Caffeine.newBuilder()
                .maximumSize(props.maxTrackedClients())
                // Drive eviction off the SAME clock as the refill (default System.nanoTime in prod, an
                // advanceable clock in tests) so the TTL below is deterministic and can't diverge from
                // the lazy-refill it's meant to mirror.
                .ticker(nanoClock::getAsLong)
                // Evict only after the FULL-REFILL HORIZON — the time a drained bucket needs to climb all
                // the way back to capacity. Only once idling that long would genuinely have refilled the
                // bucket to the brim is dropping it (and recreating a full one) behaviourally equivalent.
                // Using the bare refillPeriod (the old code) was equivalent ONLY when capacity ==
                // refillTokens; on a burst>sustained config (e.g. capacity=1000, refillTokens=60) a client
                // that drained its bucket then idled one period would be evicted and handed a fresh FULL
                // burst instead of the ~refillTokens a lazy refill grants — sustaining ~capacity/refillTokens
                // times the intended rate by simply pausing (TM-571).
                .expireAfterAccess(fullRefillHorizon(props))
                .build();
    }

    /**
     * The full-refill horizon: how long a fully-drained bucket takes to refill all the way back to
     * {@code capacity}, namely {@code capacity / refillTokens x refillPeriod}. This is the cache
     * eviction TTL — a bucket is only dropped (and later recreated at full capacity) after idling this
     * long, by which point a lazy refill would itself have topped it up to capacity, so the two are
     * behaviourally equivalent. Collapses to exactly {@code refillPeriod} for the {@code capacity ==
     * refillTokens} default, and stretches proportionally for burst&gt;sustained configs (TM-571).
     */
    static Duration fullRefillHorizon(RateLimitProperties props) {
        // capacity >= refillTokens >= 1 (Bean Validation), so the ratio is >= 1 and the horizon never
        // shrinks below the refill period. Compute in double then round to nanos — the magnitudes here
        // (period in ns x a modest ratio) stay far inside long range, so there's no overflow risk.
        long horizonNanos =
                Math.round((double) props.refillPeriod().toNanos() * props.capacity() / props.refillTokens());
        return Duration.ofNanos(horizonNanos);
    }

    /**
     * Try to spend one token for the client behind {@code request}.
     *
     * @return an {@link Decision} that is either {@linkplain Decision#allowed() allowed}, or a refusal
     *     carrying the whole-seconds {@code Retry-After} the client should wait before retrying
     */
    public Decision tryAcquire(HttpServletRequest request) {
        String key = clientKey(request);
        TokenBucket bucket = buckets.get(key, k -> new TokenBucket());
        return bucket.tryConsume();
    }

    /**
     * The bucket key: {@code uid:<uid>} for an authenticated caller (keyed per-account, so it follows
     * the user across IPs), else {@code ip:<client-ip>}. The distinct prefixes stop a uid that happens
     * to look like an IP from ever colliding with an IP bucket.
     */
    String clientKey(HttpServletRequest request) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.isAuthenticated() && auth.getPrincipal() instanceof VerifiedUser user) {
            return "uid:" + user.uid();
        }
        return "ip:" + clientIp(request);
    }

    /**
     * Resolve the originating client IP: the leftmost {@code X-Forwarded-For} entry when present
     * (Cloud Run / any reverse proxy forwards it as {@code client, proxy1, ...}), else the direct
     * socket address for plain local dev. Mirrors {@code EmailCodeRateLimiter}'s resolution and the
     * way {@code SecurityHeadersFilter} trusts {@code X-Forwarded-Proto} from the same proxy. The
     * header is client-spoofable, but the {@code maximumSize} cap means spoofing only buys a reset
     * budget, not unbounded memory.
     */
    static String clientIp(HttpServletRequest request) {
        String forwarded = request.getHeader(FORWARDED_FOR_HEADER);
        if (StringUtils.hasText(forwarded)) {
            String first = forwarded.split(",", 2)[0].trim();
            if (StringUtils.hasText(first)) {
                return first;
            }
        }
        String remote = request.getRemoteAddr();
        // Never key on null/blank — that would lump every header-less caller into one bucket; give an
        // empty marker its own (still size-capped) bucket instead.
        return StringUtils.hasText(remote) ? remote : "unknown";
    }

    /** The outcome of a token spend: allowed, or refused with the seconds to wait before retrying. */
    public record Decision(boolean allowed, long retryAfterSeconds) {
        static Decision allow() {
            return new Decision(true, 0);
        }

        static Decision deny(long retryAfterSeconds) {
            return new Decision(false, retryAfterSeconds);
        }

        public boolean allowed() {
            return allowed;
        }
    }

    /**
     * A single client's token bucket. Refills lazily (no background thread): on each spend it first
     * credits the tokens that have accrued since the last touch, capped at {@code capacity}, then
     * takes one if available. {@code synchronized} because concurrent requests from the same client
     * share one bucket.
     */
    private final class TokenBucket {

        private double tokens = capacity;
        private long lastRefillNanos = nanoClock.getAsLong();

        synchronized Decision tryConsume() {
            long now = nanoClock.getAsLong();
            long elapsed = now - lastRefillNanos;
            if (elapsed > 0) {
                tokens = Math.min(capacity, tokens + elapsed * refillPerNano);
                lastRefillNanos = now;
            }
            if (tokens >= 1.0) {
                tokens -= 1.0;
                return Decision.allow();
            }
            // Not enough for one token yet: report how long until a whole token accrues, so the client
            // can honour Retry-After. Always at least 1s so a sub-second wait still rounds up to a hint.
            double refillPerSecond = refillPerNano * 1_000_000_000.0;
            long retryAfter = (long) Math.ceil((1.0 - tokens) / refillPerSecond);
            return Decision.deny(Math.max(1, retryAfter));
        }
    }
}
