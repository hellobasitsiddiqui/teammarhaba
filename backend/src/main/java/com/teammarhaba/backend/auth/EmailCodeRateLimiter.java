package com.teammarhaba.backend.auth;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.github.benmanes.caffeine.cache.Ticker;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Clock;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

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
 * <p><strong>Client IP behind Cloud Run.</strong> Cloud Run terminates TLS at the edge and forwards
 * the real client IP in {@code X-Forwarded-For} as {@code client, proxy1, proxy2, ...}; the
 * <em>leftmost</em> entry is the originating client. We use it (mirroring how {@link
 * com.teammarhaba.backend.security.SecurityHeadersFilter} trusts {@code X-Forwarded-Proto} from the
 * same proxy), falling back to {@link HttpServletRequest#getRemoteAddr()} for plain local dev where
 * the header is absent. {@code X-Forwarded-For} is client-spoofable, but the {@code maximumSize} cap
 * means spoofing only buys an attacker a reset budget, not unbounded memory.
 *
 * <p>Process-local, like the rest of the email-code state — fine for a single Cloud Run instance; a
 * shared store (Redis) or an edge rule (Cloud Armor) is the future improvement for a global limit
 * across instances, noted in TM-247.
 */
@Component
public class EmailCodeRateLimiter {

    static final String FORWARDED_FOR_HEADER = "X-Forwarded-For";

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
     * Resolve the originating client IP: the leftmost {@code X-Forwarded-For} entry when present
     * (Cloud Run / any reverse proxy), else the direct socket address for plain local dev.
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
        // Never key on null/blank — that would lump every header-less caller into one bucket and DoS
        // legitimate dev traffic; an empty marker is its own (still size-capped) bucket instead.
        return StringUtils.hasText(remote) ? remote : "unknown";
    }
}
