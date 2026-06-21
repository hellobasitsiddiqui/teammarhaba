package com.teammarhaba.backend.web;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.servlet.FilterChain;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/**
 * Verifies the per-request correlation id: a traceId is present in the MDC while the request is
 * handled (so log lines carry it), an inbound id is propagated, and the MDC is cleared afterwards.
 */
class CorrelationIdFilterTest {

    private final CorrelationIdFilter filter = new CorrelationIdFilter();

    @AfterEach
    void clearMdc() {
        MDC.clear();
    }

    /** Runs the filter and returns the MDC traceId the wrapped chain (i.e. request handlers) sees. */
    private String runAndCaptureTraceId(MockHttpServletRequest request, MockHttpServletResponse response)
            throws Exception {
        AtomicReference<String> seenByChain = new AtomicReference<>();
        FilterChain chain = (req, res) -> seenByChain.set(MDC.get(CorrelationIdFilter.MDC_KEY));
        filter.doFilterInternal(request, response, chain);
        return seenByChain.get();
    }

    @Test
    void generatesTraceIdWhenNoInboundHeader() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();

        String traceId = runAndCaptureTraceId(new MockHttpServletRequest(), response);

        assertThat(traceId).isNotBlank();
        assertThat(response.getHeader("X-Request-Id")).isEqualTo(traceId);
    }

    @Test
    void propagatesInboundRequestId() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("X-Request-Id", "upstream-123");
        MockHttpServletResponse response = new MockHttpServletResponse();

        assertThat(runAndCaptureTraceId(request, response)).isEqualTo("upstream-123");
        assertThat(response.getHeader("X-Request-Id")).isEqualTo("upstream-123");
    }

    @Test
    void usesCloudRunTraceContextWhenPresent() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("X-Cloud-Trace-Context", "abc123def456/789;o=1");

        assertThat(runAndCaptureTraceId(request, new MockHttpServletResponse())).isEqualTo("abc123def456");
    }

    @Test
    void clearsMdcAfterTheRequest() throws Exception {
        runAndCaptureTraceId(new MockHttpServletRequest(), new MockHttpServletResponse());

        assertThat(MDC.get(CorrelationIdFilter.MDC_KEY)).isNull();
    }
}
