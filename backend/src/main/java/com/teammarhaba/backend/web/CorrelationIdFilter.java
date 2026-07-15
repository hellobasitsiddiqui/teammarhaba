package com.teammarhaba.backend.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Puts a correlation/trace id in the SLF4J MDC for the lifetime of each request, so every log
 * line emitted while handling it carries the same {@code traceId} (TM-73). With the prod JSON
 * logs (see {@code logback-spring.xml}) shipped to Cloud Logging, an operator can then grep all
 * lines for a single request.
 *
 * <p>The id is taken from an inbound header when present — an upstream {@code X-Request-Id}, or
 * the {@code X-Cloud-Trace-Context} that Cloud Run / Google's load balancer sets — so a trace
 * started at the edge propagates; otherwise a fresh one is generated. It is echoed back as
 * {@code X-Request-Id} so a caller can correlate its request to the server logs. The MDC entry is
 * always cleared in a {@code finally} block so ids never leak across pooled threads.
 *
 * <p><b>Inbound ids are untrusted (TM-724).</b> A client-supplied {@code X-Request-Id} is reflected
 * into every log line (via the MDC) and echoed into a response header, so an unbounded/arbitrary
 * value is a log-forging / response-splitting / log-flooding vector. The inbound value is therefore
 * accepted only if it matches a conservative allow-list — {@value #MAX_ID_LENGTH} chars max, drawn
 * from {@code [A-Za-z0-9._-]} (a superset of a hex UUID and of the Cloud-Trace id segment) — and any
 * value that fails validation is discarded in favour of a freshly generated id rather than trusted.
 *
 * <p>Runs first ({@code HIGHEST_PRECEDENCE}) so the id is in place before anything else logs.
 *
 * <p>This is a deliberately dependency-light alternative to Micrometer Tracing, whose Spring Boot
 * auto-configuration requires the actuator (TM-74). Keeping it standalone lets TM-73 ship
 * independently per the dependency graph (see the finding on the ticket); it can be swapped for
 * Micrometer Tracing once actuator is in place.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class CorrelationIdFilter extends OncePerRequestFilter {

    static final String MDC_KEY = "traceId";
    static final String REQUEST_ID_HEADER = "X-Request-Id";
    static final String CLOUD_TRACE_HEADER = "X-Cloud-Trace-Context";

    /** Longest inbound id we'll trust — well over a 32-char UUID/hex trace id, short enough to bound logs. */
    static final int MAX_ID_LENGTH = 64;

    /**
     * Allow-list for a trusted inbound id: 1..{@link #MAX_ID_LENGTH} chars of {@code [A-Za-z0-9._-]}.
     * Deliberately excludes whitespace and CR/LF (log-forging / header-injection) and any other
     * punctuation. Covers a hex UUID (with or without dashes) and the Cloud-Trace id segment.
     */
    private static final Pattern VALID_ID = Pattern.compile("[A-Za-z0-9._-]{1," + MAX_ID_LENGTH + "}");

    @Override
    protected void doFilterInternal(
            HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {

        String traceId = resolveTraceId(request);
        MDC.put(MDC_KEY, traceId);
        response.setHeader(REQUEST_ID_HEADER, traceId);
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.remove(MDC_KEY);
        }
    }

    private String resolveTraceId(HttpServletRequest request) {
        // Both inbound sources are client-controllable, so each is passed through the allow-list; an
        // invalid value falls through to the next source and ultimately to a freshly generated id.
        String requestId = sanitize(request.getHeader(REQUEST_ID_HEADER));
        if (requestId != null) {
            return requestId;
        }
        // Cloud Run / Google LB sets "TRACE_ID/SPAN_ID;o=1" — keep the trace-id segment.
        String cloudTrace = request.getHeader(CLOUD_TRACE_HEADER);
        if (StringUtils.hasText(cloudTrace)) {
            String traceSegment = sanitize(cloudTrace.split("/", 2)[0]);
            if (traceSegment != null) {
                return traceSegment;
            }
        }
        return UUID.randomUUID().toString().replace("-", "");
    }

    /**
     * The inbound id if it's present and passes the {@link #VALID_ID} allow-list (bounded length,
     * safe charset), else {@code null} so the caller generates a fresh id. Rejecting rather than
     * truncating/stripping keeps a hostile value from being partially reflected into logs/headers.
     */
    private static String sanitize(String candidate) {
        if (candidate == null) {
            return null;
        }
        String trimmed = candidate.trim();
        return VALID_ID.matcher(trimmed).matches() ? trimmed : null;
    }
}
