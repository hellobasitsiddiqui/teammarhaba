package com.teammarhaba.backend.security;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.util.StringUtils;

/**
 * Resolves the originating client IP from {@code X-Forwarded-For} <em>safely</em> behind a known,
 * fixed number of trusted reverse-proxy hops (TM-732).
 *
 * <p><strong>Why the leftmost entry is wrong.</strong> {@code X-Forwarded-For} is written by each
 * proxy <em>appending</em> the address it saw the request come from. So the header reads
 * {@code <spoofable...>, <client>, <proxy1>, <proxy2>, ...} — the trustworthy entries are the
 * <em>rightmost</em> ones, written by infrastructure we control; everything to their left is whatever
 * the caller chose to send. Taking the <em>leftmost</em> entry (the old code) therefore keys on a
 * value the attacker fully controls: they prepend {@code X-Forwarded-For: 1.2.3.4} and Cloud Run's
 * front end simply appends the real client IP after it. That lets a single source mint a fresh
 * rate-limit bucket per request (bypassing per-IP anti-abuse) and forge any other client's IP.
 *
 * <p><strong>The fix: count trusted hops from the right.</strong> We trust exactly
 * {@code trustedProxyHops} proxies between the client and the app (for direct Cloud Run that is
 * <strong>1</strong>: Cloud Run's front end, which always appends the true client IP as the last
 * entry). The real client is then the entry immediately to the <em>left</em> of those trusted hops:
 * index {@code (size - 1 - trustedProxyHops)} counting from the left. Anything the caller prepended
 * sits further left and is ignored. If the header is shorter than the trusted-hop count (fewer
 * entries than infrastructure would ever produce — only possible from a malformed/forged request that
 * bypassed the proxy, e.g. in local dev), we fall back to the direct socket address rather than trust
 * a caller-supplied value.
 *
 * <p>With {@code trustedProxyHops == 0} (no reverse proxy — plain local dev) the header is ignored
 * entirely and the direct socket address is used, which is exactly right: there is no trusted proxy to
 * have written the header, so any {@code X-Forwarded-For} present is purely caller-supplied.
 */
public final class ForwardedClientIp {

    public static final String FORWARDED_FOR_HEADER = "X-Forwarded-For";

    /**
     * Number of trusted reverse-proxy hops between the client and the app. <strong>1</strong> for the
     * current topology: direct Cloud Run, whose front end terminates TLS and appends the true client IP
     * as the last {@code X-Forwarded-For} entry. If the topology ever gains another trusted hop that
     * also appends to this header (e.g. an external HTTP(S) Load Balancer or Cloud Armor edge in front
     * of Cloud Run), bump this to match — otherwise the entry that hop appended would be treated as the
     * client and the real client IP ignored. It is deliberately a fixed deployment fact, not a caller-
     * tunable knob: a request can't be allowed to declare how many proxies it passed through.
     */
    public static final int TRUSTED_PROXY_HOPS = 1;

    private ForwardedClientIp() {}

    /** Resolve the client IP for {@code request} using the deployment's {@link #TRUSTED_PROXY_HOPS}. */
    public static String resolve(HttpServletRequest request) {
        return resolve(request, TRUSTED_PROXY_HOPS);
    }

    /**
     * Resolve the originating client IP for {@code request}, trusting {@code trustedProxyHops}
     * reverse-proxy hops in front of the app. Falls back to {@link HttpServletRequest#getRemoteAddr()}
     * (or {@code "unknown"} if that too is blank) when the header can't be trusted.
     */
    public static String resolve(HttpServletRequest request, int trustedProxyHops) {
        String fromHeader = fromForwardedFor(request.getHeader(FORWARDED_FOR_HEADER), trustedProxyHops);
        if (fromHeader != null) {
            return fromHeader;
        }
        String remote = request.getRemoteAddr();
        // Never key on null/blank — that would lump every socket-less caller into one bucket and DoS
        // legitimate traffic; an explicit marker is its own (still size-capped) bucket instead.
        return StringUtils.hasText(remote) ? remote : "unknown";
    }

    /**
     * The trusted client IP from a raw {@code X-Forwarded-For} value, or {@code null} when it can't be
     * trusted (no header, no trusted proxy, or fewer entries than trusted hops). Package-visible so the
     * pure string logic is unit-testable without the servlet plumbing.
     */
    public static String fromForwardedFor(String headerValue, int trustedProxyHops) {
        // No trusted proxy in front (local dev): the header is entirely caller-supplied — ignore it.
        if (trustedProxyHops <= 0 || !StringUtils.hasText(headerValue)) {
            return null;
        }
        String[] entries = headerValue.split(",");
        // The real client sits immediately left of the trusted hops: index (size - 1 - trustedHops).
        int clientIndex = entries.length - 1 - trustedProxyHops;
        if (clientIndex < 0) {
            // Fewer entries than infrastructure would ever emit — a forged/short header that didn't
            // traverse the expected proxy chain. Don't trust any of it; fall back to the socket address.
            return null;
        }
        String client = entries[clientIndex].trim();
        return StringUtils.hasText(client) ? client : null;
    }
}
