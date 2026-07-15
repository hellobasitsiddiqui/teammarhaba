package com.teammarhaba.backend.auth;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.github.benmanes.caffeine.cache.Ticker;
import com.teammarhaba.backend.security.ForwardedClientIp;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Clock;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Coarse per-IP request limiter in front of the unauthenticated {@code POST .../email-code/request}
 * (TM-247). The per-address send cooldown in {@link EmailCodeService} does nothing against a flood of
 * <em>distinct</em> random addresses from one source — this caps how many {@code request} calls one
 * client IP may make within a fixed window, failing closed with {@code 429}
 * ({@link EmailCodeException.Reason#IP_RATE_LIMITED}) once the limit is hit.
 *
 * <p><strong>Bounded by construction.</strong> The counters live in a Caffeine cache that both
 * {@linkplain Caffeine#expireAfterWrite expires} each entry after the window (so a fixed window
 * resets cleanly) and is {@linkplain Caffeine#maximumSize size-capped} at
 * {@link EmailCodeProperties#maxTrackedIps()}. That cap is the critical bit: it stops the limiter
 * from itself becoming a new unbounded map when an attacker rotates a spoofed {@code X-Forwarded-For}
 * — i.e. it doesn't trade one unbounded map for another. Worst case, the oldest counters are evicted
 * and those IPs get a fresh budget; memory stays bounded.
 *
 * <p><strong>Client IP behind Cloud Run (TM-732).</strong> Cloud Run terminates TLS at the edge and
 * <em>appends</em> the real client IP to {@code X-Forwarded-For} as the last entry. The
 * <em>leftmost</em> entries are whatever the caller sent and are attacker-controlled — keying on the
 * leftmost let a single source spoof any IP and mint a fresh per-IP bucket every request, defeating
 * this limiter entirely. Resolution is delegated to {@link
 * com.teammarhaba.backend.security.ForwardedClientIp}, which counts trusted proxy hops in from the
 * <em>right</em>, falling back to {@link HttpServletRequest#getRemoteAddr()} for plain local dev where
 * the header is absent. The {@code maximumSize} cap still bounds memory under any header flood.
 *
 * <p>Process-local, like the rest of the email-code state — fine for a single Cloud Run instance; a
 * shared store (Redis) or an edge rule (Cloud Armor) is the future improvement for a global limit
 * across instances, noted in TM-247.
 */
@Component
public class EmailCodeRateLimiter {

    private final EmailCodeProperties props;
    private final Cache<String, AtomicInteger> hitsByIp;

    @Autowired
    public EmailCodeRateLimiter(EmailCodeProperties props) {
        this(props, Clock.systemUTC());
    }

    /** Test seam: an advanceable {@link Clock} drives the window expiry deterministically. */
    EmailCodeRateLimiter(EmailCodeProperties props, Clock clock) {
        this.props = props;
        Ticker ticker = () -> clock.instant().toEpochMilli() * 1_000_000L;
        this.hitsByIp = Caffeine.newBuilder()
                .ticker(ticker)
                .expireAfterWrite(props.ipRequestWindow())
                .maximumSize(props.maxTrackedIps())
                .build();
    }

    /**
     * Record one {@code request} from {@code request}'s client IP and enforce the per-IP limit.
     *
     * @throws EmailCodeException with {@link EmailCodeException.Reason#IP_RATE_LIMITED} once this IP
     *     has exceeded {@link EmailCodeProperties#ipRequestLimit()} calls inside the current window
     */
    public void checkAndRecord(HttpServletRequest request) {
        checkAndRecord(clientIp(request));
    }

    /** IP-string overload — the unit-testable core, independent of the servlet plumbing. */
    void checkAndRecord(String clientIp) {
        AtomicInteger counter = hitsByIp.get(clientIp, ip -> new AtomicInteger());
        int count = counter.incrementAndGet();
        if (count > props.ipRequestLimit()) {
            throw new EmailCodeException(
                    EmailCodeException.Reason.IP_RATE_LIMITED,
                    "Too many requests from your network. Please wait before requesting another code.");
        }
    }

    /**
     * Test seam (TM-247): the number of IPs the limiter currently tracks, after forcing pending
     * eviction. Lets a flood test assert the limiter's own store stays bounded (not N).
     */
    long trackedIpCount() {
        hitsByIp.cleanUp();
        return hitsByIp.estimatedSize();
    }

    /**
     * Resolve the originating client IP behind the trusted proxy chain (TM-732): the entry Cloud Run's
     * front end appended to {@code X-Forwarded-For}, counting {@link ForwardedClientIp#TRUSTED_PROXY_HOPS}
     * hops in from the right, else the direct socket address for plain local dev. Using the leftmost entry
     * would be wrong — it's the attacker-controlled value a caller can prepend to mint a fresh per-IP
     * bucket every request, defeating this limiter. Delegates to the shared {@link ForwardedClientIp} so
     * this and the API-wide {@code RateLimiter} resolve the client identically.
     */
    static String clientIp(HttpServletRequest request) {
        return ForwardedClientIp.resolve(request);
    }
}
