package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

/**
 * Unit tests for {@link EmailCodeRateLimiter} (TM-247): the coarse per-IP limit returns 429 after the
 * threshold, the window resets, distinct IPs have independent budgets, the limiter's own store is
 * bounded under an IP flood, and the client IP is taken from {@code X-Forwarded-For} behind the proxy.
 */
class EmailCodeRateLimiterTest {

    private static final Instant T0 = Instant.parse("2026-01-01T00:00:00Z");

    /** length/ttl/cooldown/attempts are irrelevant here; the per-IP knobs are what matter. */
    private static EmailCodeProperties props(int ipLimit, Duration window, long maxTrackedIps) {
        return new EmailCodeProperties(
                6, Duration.ofMinutes(10), Duration.ofSeconds(60), 5, 100_000, ipLimit, window, maxTrackedIps);
    }

    @Test
    void perIpLimitReturns429AfterThreshold() {
        MutableClock clock = new MutableClock(T0);
        EmailCodeRateLimiter limiter = new EmailCodeRateLimiter(props(3, Duration.ofMinutes(1), 100_000), clock);

        // 3 allowed, the 4th from the same IP trips IP_RATE_LIMITED.
        for (int i = 0; i < 3; i++) {
            assertThatCode(() -> limiter.checkAndRecord("203.0.113.7")).doesNotThrowAnyException();
        }
        assertThatThrownBy(() -> limiter.checkAndRecord("203.0.113.7"))
                .isInstanceOf(EmailCodeException.class)
                .extracting(e -> ((EmailCodeException) e).reason())
                .isEqualTo(EmailCodeException.Reason.IP_RATE_LIMITED);
    }

    @Test
    void windowResetsAfterItElapses() {
        MutableClock clock = new MutableClock(T0);
        EmailCodeRateLimiter limiter = new EmailCodeRateLimiter(props(2, Duration.ofMinutes(1), 100_000), clock);

        limiter.checkAndRecord("198.51.100.4");
        limiter.checkAndRecord("198.51.100.4");
        assertThatThrownBy(() -> limiter.checkAndRecord("198.51.100.4")).isInstanceOf(EmailCodeException.class);

        clock.advance(Duration.ofMinutes(1).plusSeconds(1)); // window elapses -> counter expires
        assertThatCode(() -> limiter.checkAndRecord("198.51.100.4")).doesNotThrowAnyException();
    }

    @Test
    void distinctIpsHaveIndependentBudgets() {
        MutableClock clock = new MutableClock(T0);
        EmailCodeRateLimiter limiter = new EmailCodeRateLimiter(props(1, Duration.ofMinutes(1), 100_000), clock);

        limiter.checkAndRecord("10.0.0.1"); // uses up IP #1's single allowance
        // A different IP is unaffected by IP #1 exhausting its budget.
        assertThatCode(() -> limiter.checkAndRecord("10.0.0.2")).doesNotThrowAnyException();
    }

    @Test
    void limiterStoreIsBoundedUnderAnIpFlood() {
        MutableClock clock = new MutableClock(T0);
        // maxTrackedIps = 100: a flood of distinct (e.g. spoofed X-Forwarded-For) IPs must not grow the
        // limiter without limit — it must NOT trade one unbounded map for another.
        EmailCodeRateLimiter limiter = new EmailCodeRateLimiter(props(20, Duration.ofMinutes(1), 100), clock);

        for (int i = 0; i < 10_000; i++) {
            limiter.checkAndRecord("192.0.2." + i);
        }
        assertThat(limiter.trackedIpCount()).isLessThan(10_000L);
        assertThat(limiter.trackedIpCount()).isLessThanOrEqualTo(100L * 3); // Caffeine slack, still bounded
    }

    @Test
    void clientIpPrefersLeftmostXForwardedForEntry() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRemoteAddr("169.254.0.1"); // the proxy's socket address — must be ignored
        request.addHeader(EmailCodeRateLimiter.FORWARDED_FOR_HEADER, "203.0.113.7, 70.41.3.18, 150.172.238.178");

        assertThat(EmailCodeRateLimiter.clientIp(request)).isEqualTo("203.0.113.7");
    }

    @Test
    void clientIpFallsBackToRemoteAddrWithoutTheHeader() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRemoteAddr("127.0.0.1"); // plain local dev: no proxy header

        assertThat(EmailCodeRateLimiter.clientIp(request)).isEqualTo("127.0.0.1");
    }

    /** A test {@link Clock} whose instant can be advanced to drive the window expiry deterministically. */
    private static final class MutableClock extends Clock {
        private Instant now;

        MutableClock(Instant start) {
            this.now = start;
        }

        void advance(Duration by) {
            now = now.plus(by);
        }

        @Override
        public Instant instant() {
            return now;
        }

        @Override
        public ZoneOffset getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }
    }
}
