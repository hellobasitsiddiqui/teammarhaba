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
    void anonymousCallerIsKeyedByClientIp() {
        // Leftmost X-Forwarded-For wins (the originating client behind Cloud Run's proxy chain).
        MockHttpServletRequest forwarded = request("10.0.0.1");
        forwarded.addHeader("X-Forwarded-For", "9.9.9.9, 10.0.0.1");
        assertThat(limiter.clientKey(forwarded)).isEqualTo("ip:9.9.9.9");

        // No forwarding header -> fall back to the direct socket address.
        assertThat(limiter.clientKey(request("10.0.0.1"))).isEqualTo("ip:10.0.0.1");
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
