package com.teammarhaba.backend.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Emits baseline security headers on every response so the base ships hardened
 * by default (TM-78). Implemented as a plain servlet filter rather than via
 * Spring Security: the walking skeleton has no auth yet, and pulling in
 * {@code spring-boot-starter-security} would lock down {@code /health} (401) and
 * introduce a {@code SecurityFilterChain} that the auth ticket (1.6.10) would have
 * to unpick. Headers are a cross-cutting concern and don't need the auth machinery.
 *
 * <p>Headers set:
 * <ul>
 *   <li><b>Strict-Transport-Security</b> — only on secure / forwarded-HTTPS requests,
 *       so plaintext local dev (http) is never pinned to HTTPS.</li>
 *   <li><b>X-Frame-Options: DENY</b> and CSP <b>frame-ancestors 'none'</b> —
 *       belt-and-braces clickjacking protection (legacy + modern).</li>
 *   <li><b>Content-Security-Policy</b> — a locked-down starter policy. The API
 *       serves JSON, not the web UI (that's Firebase Hosting on a separate origin),
 *       so {@code default-src 'self'} is safe and doesn't touch the web surface.</li>
 *   <li><b>X-Content-Type-Options: nosniff</b> and <b>Referrer-Policy</b> —
 *       zero-risk baseline hardening.</li>
 * </ul>
 *
 * <p>Runs early ({@code HIGHEST_PRECEDENCE}) so the headers are on the response
 * before any handler writes the body.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class SecurityHeadersFilter extends OncePerRequestFilter {

    // One year, and apply to subdomains. No `preload` — preloading is a hard-to-reverse
    // commitment that a reusable base shouldn't make on the consumer's behalf.
    static final String HSTS_VALUE = "max-age=31536000; includeSubDomains";

    // Starter policy for a JSON API: deny everything by default, allow same-origin,
    // and forbid framing. Documented in backend/README.md; tune per-route in later work.
    static final String CSP_VALUE =
            "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

    @Override
    protected void doFilterInternal(
            HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {

        if (isSecure(request)) {
            response.setHeader("Strict-Transport-Security", HSTS_VALUE);
        }
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader("Content-Security-Policy", CSP_VALUE);
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");

        chain.doFilter(request, response);
    }

    /**
     * True when the request reached us over HTTPS. Behind Cloud Run (TLS terminated at
     * the edge) {@code request.isSecure()} is false, so we also trust the
     * {@code X-Forwarded-Proto} header the platform sets. Plain HTTP dev is neither, so
     * HSTS is correctly withheld there.
     */
    private boolean isSecure(HttpServletRequest request) {
        return request.isSecure()
                || "https".equalsIgnoreCase(request.getHeader("X-Forwarded-Proto"));
    }
}
