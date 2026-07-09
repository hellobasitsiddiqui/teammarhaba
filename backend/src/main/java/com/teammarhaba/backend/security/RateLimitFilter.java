package com.teammarhaba.backend.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.teammarhaba.backend.security.RateLimiter.Decision;
import com.teammarhaba.backend.web.Problems;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Enforces the per-client API rate limit (TM-158) on {@code /api/**}. Runs <em>after</em>
 * {@code FirebaseAuthenticationFilter} in the security chain (wired in {@link SecurityConfig}) so the
 * authenticated {@link com.teammarhaba.backend.auth.VerifiedUser} principal is already in the
 * {@code SecurityContext} and {@link RateLimiter} can key the bucket by {@code uid}; anonymous traffic
 * falls back to client IP.
 *
 * <p><strong>Scope.</strong> Only {@code /api/**} is limited — {@code /health}, the
 * readiness/liveness probes ({@code /actuator/health/**}) and {@code /version} live outside that
 * prefix and are therefore inherently exempt, so a throttled abuser can never take the instance out
 * of rotation. When the limit is exceeded the request is refused with a uniform RFC 7807
 * {@code 429 Too Many Requests} (same {@code application/problem+json} shape as every other error, via
 * {@link Problems} — the TM-72 error model) plus a {@code Retry-After} header telling the client how
 * long to back off. A stack trace is never leaked.
 *
 * <p>Instantiated by {@link SecurityConfig} (not component-scanned) so it is registered exactly once —
 * inside the security chain — and never double-registered as a bare servlet filter. It's a no-op when
 * {@link RateLimitProperties#enabled()} is false (the {@code test} profile), so the rest of the
 * integration suite isn't throttled.
 */
public class RateLimitFilter extends OncePerRequestFilter {

    /** Only requests under this prefix are rate-limited; everything else is exempt (probes, /version). */
    static final String API_PREFIX = "/api/";

    private final RateLimiter rateLimiter;
    private final RateLimitProperties props;
    private final ObjectMapper objectMapper;

    public RateLimitFilter(RateLimiter rateLimiter, RateLimitProperties props, ObjectMapper objectMapper) {
        this.rateLimiter = rateLimiter;
        this.props = props;
        this.objectMapper = objectMapper;
    }

    /** Skip everything the limiter doesn't govern: it's off, or the path isn't part of the API surface. */
    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !props.enabled() || !request.getRequestURI().startsWith(API_PREFIX);
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {

        Decision decision = rateLimiter.tryAcquire(request);
        if (decision.allowed()) {
            chain.doFilter(request, response);
            return;
        }
        writeTooManyRequests(response, decision.retryAfterSeconds());
    }

    /** Refuse with a uniform RFC 7807 429 + a whole-seconds {@code Retry-After}. */
    private void writeTooManyRequests(HttpServletResponse response, long retryAfterSeconds) throws IOException {
        ProblemDetail problem = Problems.of(
                HttpStatus.TOO_MANY_REQUESTS,
                "Too many requests",
                "Rate limit exceeded. Please slow down and retry after a moment.");

        response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
        response.setHeader(HttpHeaders.RETRY_AFTER, Long.toString(retryAfterSeconds));
        response.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        objectMapper.writeValue(response.getWriter(), problem);
    }
}
