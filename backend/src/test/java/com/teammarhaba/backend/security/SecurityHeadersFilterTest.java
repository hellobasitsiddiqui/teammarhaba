package com.teammarhaba.backend.security;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/**
 * Verifies the baseline security headers are emitted, and that HSTS is gated on a
 * secure / forwarded-HTTPS request so plaintext dev is never pinned to HTTPS.
 */
class SecurityHeadersFilterTest {

    private final SecurityHeadersFilter filter = new SecurityHeadersFilter();

    @Test
    void alwaysSetsFrameOptionsCspAndHardeningHeaders() throws Exception {
        MockHttpServletResponse response = invoke(new MockHttpServletRequest());

        assertThat(response.getHeader("X-Frame-Options")).isEqualTo("DENY");
        assertThat(response.getHeader("Content-Security-Policy"))
                .contains("default-src 'self'")
                .contains("frame-ancestors 'none'");
        assertThat(response.getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
        assertThat(response.getHeader("Referrer-Policy")).isEqualTo("no-referrer");
    }

    @Test
    void omitsHstsOnPlainHttp() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setSecure(false);

        MockHttpServletResponse response = invoke(request);

        assertThat(response.getHeader("Strict-Transport-Security")).isNull();
    }

    @Test
    void setsHstsWhenRequestIsSecure() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setSecure(true);

        MockHttpServletResponse response = invoke(request);

        assertThat(response.getHeader("Strict-Transport-Security"))
                .isEqualTo("max-age=31536000; includeSubDomains");
    }

    @Test
    void setsHstsWhenForwardedProtoIsHttps() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setSecure(false);
        request.addHeader("X-Forwarded-Proto", "https");

        MockHttpServletResponse response = invoke(request);

        assertThat(response.getHeader("Strict-Transport-Security"))
                .isEqualTo("max-age=31536000; includeSubDomains");
    }

    private MockHttpServletResponse invoke(MockHttpServletRequest request) throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter.doFilter(request, response, new MockFilterChain());
        return response;
    }
}
