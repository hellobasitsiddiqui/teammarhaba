package com.teammarhaba.backend.security;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

/**
 * Unit tests for {@link ForwardedClientIp} (TM-732): the client IP must be taken from the entry the
 * trusted proxy (Cloud Run) <em>appended</em> to {@code X-Forwarded-For} — counted from the right —
 * never the attacker-controlled leftmost entry a caller can prepend to forge an IP or reset a per-IP
 * rate-limit bucket. This is the shared core behind both {@code RateLimiter} and
 * {@code EmailCodeRateLimiter}.
 */
class ForwardedClientIpTest {

    @Test
    void singleTrustedHopTakesTheProxyAppendedLastEntry() {
        // Header written by the proxy: "<client>, <cloudrun>". One trusted hop -> client is index 0.
        assertThat(ForwardedClientIp.fromForwardedFor("203.0.113.7, 130.211.0.1", 1)).isEqualTo("203.0.113.7");
    }

    @Test
    void prependedSpoofEntriesAreIgnored() {
        // Attacker prepends two forged IPs; Cloud Run still appends the true client as the last entry.
        // With one trusted hop the resolved IP is the second-from-last — the address the front end saw —
        // NOT the attacker's leftmost "1.1.1.1".
        assertThat(ForwardedClientIp.fromForwardedFor("1.1.1.1, 2.2.2.2, 203.0.113.7, 130.211.0.1", 1))
                .isEqualTo("203.0.113.7");
    }

    @Test
    void twoTrustedHopsCountTwoInFromTheRight() {
        // "<client>, <lb>, <cloudrun>" with two trusted hops -> client is index (3 - 1 - 2) = 0.
        assertThat(ForwardedClientIp.fromForwardedFor("203.0.113.7, 10.0.0.9, 130.211.0.1", 2))
                .isEqualTo("203.0.113.7");
    }

    @Test
    void entriesAreTrimmed() {
        assertThat(ForwardedClientIp.fromForwardedFor("  203.0.113.7 ,  130.211.0.1 ", 1)).isEqualTo("203.0.113.7");
    }

    @Test
    void headerShorterThanTrustedHopsIsNotTrusted() {
        // Only the proxy's own hop present (no client entry to its left) — a malformed/forged header that
        // didn't traverse the full chain. Don't trust any of it; signal fall-back with null.
        assertThat(ForwardedClientIp.fromForwardedFor("130.211.0.1", 1)).isNull();
    }

    @Test
    void zeroTrustedHopsIgnoresTheHeaderEntirely() {
        // No trusted proxy in front (plain local dev): the whole header is caller-supplied — ignore it.
        assertThat(ForwardedClientIp.fromForwardedFor("1.2.3.4, 5.6.7.8", 0)).isNull();
    }

    @Test
    void blankOrMissingHeaderIsNotTrusted() {
        assertThat(ForwardedClientIp.fromForwardedFor(null, 1)).isNull();
        assertThat(ForwardedClientIp.fromForwardedFor("   ", 1)).isNull();
    }

    @Test
    void resolveFallsBackToRemoteAddrWhenHeaderUntrusted() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRemoteAddr("127.0.0.1"); // no forwarding header -> plain socket address
        assertThat(ForwardedClientIp.resolve(request)).isEqualTo("127.0.0.1");
    }

    @Test
    void resolveUsesProxyAppendedEntryOverRemoteAddr() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRemoteAddr("169.254.0.1"); // proxy socket address — ignored when the header is trusted
        request.addHeader(ForwardedClientIp.FORWARDED_FOR_HEADER, "9.9.9.9, 203.0.113.7, 130.211.0.1");
        // Default TRUSTED_PROXY_HOPS = 1 -> the second-from-last entry, not the prepended "9.9.9.9".
        assertThat(ForwardedClientIp.resolve(request)).isEqualTo("203.0.113.7");
    }

    @Test
    void resolveFallsBackToUnknownWhenNoSocketAddressAndUntrustedHeader() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRemoteAddr(""); // never key on blank
        assertThat(ForwardedClientIp.resolve(request)).isEqualTo("unknown");
    }
}
