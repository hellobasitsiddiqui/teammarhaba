package com.teammarhaba.backend.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.TestcontainersConfiguration;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Verifies the {@code /api/v1} versioning convention: application endpoints are served
 * under {@code /api/v1}, the bare (unprefixed) path is not, and the {@code /health} probe
 * stays unversioned so the Cloud Run deploy probes keep working.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Import(TestcontainersConfiguration.class)
class ApiVersioningTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void apiEndpointsAreServedUnderApiV1() throws Exception {
        mockMvc.perform(get("/api/v1/meta"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.version").value("v1"));
    }

    @Test
    void unprefixedApiPathIsNotMapped() throws Exception {
        mockMvc.perform(get("/meta")).andExpect(status().isNotFound());
    }

    @Test
    void healthProbeStaysUnversioned() throws Exception {
        mockMvc.perform(get("/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("UP"));
    }
}
