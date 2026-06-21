package com.teammarhaba.backend.security;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.HealthController;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Proves the filter is wired into the live MVC chain: a real GET /health response
 * carries the baseline headers (not just the filter in isolation).
 */
@WebMvcTest(HealthController.class)
@Import({SecurityHeadersFilter.class, SecurityConfig.class})
class SecurityHeadersWiringTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void healthResponseCarriesSecurityHeaders() throws Exception {
        mockMvc.perform(get("/health"))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Frame-Options", "DENY"))
                .andExpect(header().string("X-Content-Type-Options", "nosniff"))
                .andExpect(header().exists("Content-Security-Policy"));
    }
}
