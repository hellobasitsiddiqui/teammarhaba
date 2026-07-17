package com.teammarhaba.backend.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.security.RateLimiter.Decision;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * Unit tests for the token-bucket core (TM-158), driving refill with an advanceable nano-clock so the
 * behaviour is deterministic (no sleeps). Covers the two keying modes (uid vs IP), the burst → deny →
 * refill lifecycle, the {@code Retry-After} hint, and per-client isolation. The servlet-chain wiring
 * and the 429 body are covered separately by {@link RateLimitFilterIntegrationTest}.
 */
class RateLimiterTest {

    // 2 tokens, refilled fully every second: an easy budget to reason about across clock ticks.
    private final RateLimitProperties props = new RateLimitProperties(true, 2, 2, Duration.ofSeconds(1), 100);
    private final AtomicLong nanos = new AtomicLong(0);
    private final RateLimiter limiter = new RateLimiter(props, nanos::get);

    @AfterEach
    void clearContext() {
        // The context holder is a thread-local static — never let a test's auth leak into the next one.
        SecurityContextHolder.clearContext();
    }

    private static MockHttpServletRequest request(String remoteAddr) {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRemoteAddr(remoteAddr);
        return request;
    }

    @Test
    void ipKeyedClientBurstsToCapacityThenIsDenied() {
        MockHttpServletRequest request = request("1.2.3.4");

        assertThat(limiter.tryAcquire(request).allowed()).isTrue(); // token 1 of 2
        assertThat(limiter.tryAcquire(request).allowed()).isTrue(); // token 2 of 2

        Decision denied = limiter.tryAcquire(request); // budget spent
        assertThat(denied.allowed()).isFalse();
        assertThat(denied.retryAfterSeconds()).isGreaterThanOrEqualTo(1);
    }

    @Test
    void budgetRefillsAfterThePeriodElapses() {
        MockHttpServletRequest request = request("1.2.3.4");
        limiter.tryAcquire(request);
        limiter.tryAcquire(request);
        assertThat(limiter.tryAcquire(request).allowed()).isFalse();

        // Advance a full refill period: the bucket tops back up to capacity and lets requests through.
        nanos.addAndGet(Duration.ofSeconds(1).toNanos());
        assertThat(limiter.tryAcquire(request).allowed()).isTrue();
    }

    @Test
    void authenticatedCallerIsKeyedByUidNotIp() {
        SecurityContextHolder.getContext()
                .setAuthentication(new UsernamePasswordAuthenticationToken(
                        new VerifiedUser("user-123", "a@example.test"), null, List.of()));

        assertThat(limiter.clientKey(request("1.2.3.4"))).isEqualTo("uid:user-123");
    }

    @Test
    void anonymousCallerIsKeyedByTheProxyAppendedClientIp_notTheSpoofableLeftmost() {
        // TM-858: for direct Cloud Run, GFE APPENDS the real client IP as the LAST X-Forwarded-For
        // entry. A caller can prepend anything to forge an IP / mint a fresh bucket. Header
        // "9.9.9.9, 130.211.0.1, 8.8.8.8": the client prepended "9.9.9.9" and "130.211.0.1", and GFE
        // appended the true client "8.8.8.8" (what it saw) last. With one trusted hop the key must be
        // that true client — not the attacker-prepended leftmost "9.9.9.9" the pre-TM-732 code used, nor
        // the spoofable second-from-last entry the TM-732 code mistakenly picked.
        MockHttpServletRequest forwarded = request("169.254.0.1");
        forwarded.addHeader("X-Forwarded-For", "9.9.9.9, 130.211.0.1, 8.8.8.8");
        assertThat(limiter.clientKey(forwarded)).isEqualTo("ip:8.8.8.8");

        // No forwarding header -> fall back to the direct socket address.
        assertThat(limiter.clientKey(request("10.0.0.1"))).isEqualTo("ip:10.0.0.1");
    }

    @Test
    void burstGreaterThanSustainedDoesNotGrantFreeFullBurstAcrossIdleEviction() {
        // Regression for TM-571. A tightened config where burst (capacity) far exceeds the sustained
        // rate (refillTokens/period): 10-token burst but only 2 tokens/sec sustained. The full-refill
        // horizon is capacity/refillTokens x period = 10/2 x 1s = 5s, so a client that drains its
        // bucket then idles ONE period (1.5s) is long enough to be evicted under the OLD
        // expireAfterAccess(refillPeriod) — which would recreate a FULL 10-token bucket — but is well
        // inside the 5s horizon under the fix, so the bucket survives and only lazily refills.
        RateLimitProperties burst = new RateLimitProperties(true, 10, 2, Duration.ofSeconds(1), 100);
        AtomicLong clock = new AtomicLong(0);
        RateLimiter burstLimiter = new RateLimiter(burst, clock::get);
        MockHttpServletRequest request = request("1.2.3.4");

        // Empty the whole 10-token burst, then confirm the bucket is spent.
        for (int i = 0; i < 10; i++) {
            assertThat(burstLimiter.tryAcquire(request).allowed()).isTrue();
        }
        assertThat(burstLimiter.tryAcquire(request).allowed()).isFalse();

        // Idle just over one refill period (1.6s) — the exact "pause to reset" an attacker would use.
        clock.addAndGet(Duration.ofMillis(1600).toNanos());

        // The sustained rate holds: lazy refill grants only 2 tokens/sec x 1.6s = ~3.2 tokens, so at
        // most three requests get through before the next denial — NOT a free full burst of 10. Under
        // the old idle-eviction bug this loop would have allowed all ten (a fresh full bucket).
        int allowedAfterIdle = 0;
        for (int i = 0; i < 10; i++) {
            if (burstLimiter.tryAcquire(request).allowed()) {
                allowedAfterIdle++;
            }
        }
        assertThat(allowedAfterIdle).isEqualTo(3);
    }

    @Test
    void fullRefillHorizonStretchesWithBurstButCollapsesToPeriodWhenBalanced() {
        // The eviction TTL is capacity/refillTokens x refillPeriod. For the balanced default
        // (capacity == refillTokens) it is exactly the refill period — the pre-fix behaviour, preserved.
        assertThat(RateLimiter.fullRefillHorizon(
                        new RateLimitProperties(true, 120, 120, Duration.ofMinutes(1), 100)))
                .isEqualTo(Duration.ofMinutes(1));

        // For a burst>sustained config it stretches proportionally: 1000/60 x 1m = ~16m40s.
        assertThat(RateLimiter.fullRefillHorizon(
                        new RateLimitProperties(true, 1000, 60, Duration.ofMinutes(1), 100)))
                .isEqualTo(Duration.ofMinutes(1).multipliedBy(1000).dividedBy(60));
    }

    @Test
    void distinctClientsHaveIndependentBudgets() {
        MockHttpServletRequest a = request("1.1.1.1");
        MockHttpServletRequest b = request("2.2.2.2");

        // Exhaust client A entirely.
        limiter.tryAcquire(a);
        limiter.tryAcquire(a);
        assertThat(limiter.tryAcquire(a).allowed()).isFalse();

        // Client B still has its own full budget.
        assertThat(limiter.tryAcquire(b).allowed()).isTrue();
        assertThat(limiter.tryAcquire(b).allowed()).isTrue();
    }
}
