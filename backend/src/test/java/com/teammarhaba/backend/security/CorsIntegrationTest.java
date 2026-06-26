package com.teammarhaba.backend.security;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/**
 * CORS preflight behaviour (TM-104): an allowed origin gets the cross-origin headers on an
 * {@code OPTIONS /api/**} preflight; a disallowed origin is rejected. The preflight is answered
 * ahead of authentication, so no token is involved.
 */
@AutoConfigureMockMvc
@TestPropertySource(properties = "app.cors.allowed-origins=http://127.0.0.1:8081")
class CorsIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void allowsPreflightFromConfiguredOrigin() throws Exception {
        mockMvc.perform(options("/api/v1/me")
                        .header(HttpHeaders.ORIGIN, "http://127.0.0.1:8081")
                        .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "GET"))
                .andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, "http://127.0.0.1:8081"))
                .andExpect(header().exists(HttpHeaders.ACCESS_CONTROL_ALLOW_METHODS));
    }

    @Test
    void rejectsPreflightFromUnknownOrigin() throws Exception {
        mockMvc.perform(options("/api/v1/me")
                        .header(HttpHeaders.ORIGIN, "https://evil.example.com")
                        .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "GET"))
                .andExpect(status().isForbidden());
    }

    /**
     * Regression for TM-308: {@code /version} is a public, root-level (unversioned) endpoint the web
     * first page fetches cross-origin. It lives outside {@code /api/**}, so before the fix it had no
     * CORS coverage and an allowed origin got no {@code Access-Control-Allow-Origin} header — the
     * browser/WebView blocked the fetch. The actual GET must now carry the header for an allowed
     * origin.
     */
    @Test
    void versionCarriesCorsHeaderForAllowedOrigin() throws Exception {
        mockMvc.perform(get("/version").header(HttpHeaders.ORIGIN, "http://127.0.0.1:8081"))
                .andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, "http://127.0.0.1:8081"));
    }

    @Test
    void versionAllowsPreflightFromConfiguredOrigin() throws Exception {
        mockMvc.perform(options("/version")
                        .header(HttpHeaders.ORIGIN, "http://127.0.0.1:8081")
                        .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "GET"))
                .andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, "http://127.0.0.1:8081"));
    }

    @Test
    void healthCarriesCorsHeaderForAllowedOrigin() throws Exception {
        mockMvc.perform(get("/health").header(HttpHeaders.ORIGIN, "http://127.0.0.1:8081"))
                .andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, "http://127.0.0.1:8081"));
    }
}
