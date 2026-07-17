package com.teammarhaba.backend.security;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

/**
 * Unit tests for {@link ForwardedClientIp} (TM-732, corrected in TM-858): the client IP must be taken
 * from the entry Google's front end (GFE) <em>appended last</em> to {@code X-Forwarded-For} for this
 * direct Cloud Run topology — the rightmost, trusted entry — never the attacker-controlled leftmost
 * entries a caller can prepend to forge an IP or reset a per-IP rate-limit bucket. This is the shared
 * core behind both {@code RateLimiter} and {@code EmailCodeRateLimiter}.
 *
 * <p>These tests model Cloud Run's <em>real</em> XFF shape: GFE appends the true client IP as the LAST
 * entry, so with one trusted hop the client is the rightmost entry. The pre-TM-858 code indexed the
 * second-from-last entry, so these assertions fail against it and pass on the fix.
 */
class ForwardedClientIpTest {

    @Test
    void singleTrustedHopTakesTheProxyAppendedLastEntry() {
        // GFE appends the real client IP LAST for direct Cloud Run: "<...>, <client>". One trusted hop
        // -> the client is the rightmost entry. A direct request with no prepend is just "<client>".
        assertThat(ForwardedClientIp.fromForwardedFor("203.0.113.7", 1)).isEqualTo("203.0.113.7");
    }

    @Test
    void prependedSpoofEntriesAreIgnored() {
        // Attacker prepends forged IPs; GFE still appends the true client "203.0.113.7" as the LAST
        // entry. With one trusted hop the resolved IP is that rightmost entry — the true client GFE saw
        // — NOT any of the attacker's prepended, spoofable "1.1.1.1"/"2.2.2.2"/"130.211.0.1".
        assertThat(ForwardedClientIp.fromForwardedFor("1.1.1.1, 2.2.2.2, 130.211.0.1, 203.0.113.7", 1))
                .isEqualTo("203.0.113.7");
    }

    @Test
    void twoTrustedHopsCountTwoInFromTheRight() {
        // A second trusted appending hop (external LB) in front: "<client>, <lb>" where GFE wrote the
        // client and the LB appended its own IP last. Two trusted hops -> client is index (2 - 2) = 0.
        assertThat(ForwardedClientIp.fromForwardedFor("203.0.113.7, 10.0.0.9", 2))
                .isEqualTo("203.0.113.7");
    }

    @Test
    void entriesAreTrimmed() {
        // GFE appends the client last; whitespace around entries is trimmed before comparison.
        assertThat(ForwardedClientIp.fromForwardedFor("  130.211.0.1 ,  203.0.113.7 ", 1)).isEqualTo("203.0.113.7");
    }

    @Test
    void headerShorterThanTrustedHopsIsNotTrusted() {
        // Two trusted hops but only one entry: fewer entries than the infrastructure chain would ever
        // emit (index (1 - 2) = -1) — a malformed/forged header that didn't traverse the full chain.
        // Don't trust any of it; signal fall-back with null.
        assertThat(ForwardedClientIp.fromForwardedFor("203.0.113.7", 2)).isNull();
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
        request.addHeader(ForwardedClientIp.FORWARDED_FOR_HEADER, "9.9.9.9, 130.211.0.1, 203.0.113.7");
        // Default TRUSTED_PROXY_HOPS = 1 -> the LAST entry GFE appended ("203.0.113.7"), not the
        // prepended, spoofable "9.9.9.9"/"130.211.0.1".
        assertThat(ForwardedClientIp.resolve(request)).isEqualTo("203.0.113.7");
    }

    @Test
    void resolveFallsBackToUnknownWhenNoSocketAddressAndUntrustedHeader() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRemoteAddr(""); // never key on blank
        assertThat(ForwardedClientIp.resolve(request)).isEqualTo("unknown");
    }
}
