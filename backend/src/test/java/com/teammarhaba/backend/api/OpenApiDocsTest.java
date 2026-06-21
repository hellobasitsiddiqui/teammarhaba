package com.teammarhaba.backend.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Verifies the OpenAPI surface (TM-76): the spec is served at {@code /v3/api-docs} with the
 * configured metadata and reflects the actual endpoints, and the Swagger UI is reachable.
 * Runs on the full context via the shared Testcontainers harness, under the {@code test}
 * profile where springdoc is enabled (it is disabled on prod).
 */
@AutoConfigureMockMvc
class OpenApiDocsTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void apiDocsSpecIsServedAndReflectsEndpoints() throws Exception {
        mockMvc.perform(get("/v3/api-docs"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.openapi").exists())
                .andExpect(jsonPath("$.info.title").value("TeamMarhaba Backend API"))
                .andExpect(jsonPath("$.info.version").value("v1"))
                // generated from the live handler mappings — proves it reflects real endpoints
                .andExpect(jsonPath("$.paths['/health']").exists())
                .andExpect(jsonPath("$.paths['/api/v1/meta']").exists());
    }

    @Test
    void swaggerUiIsReachable() throws Exception {
        mockMvc.perform(get("/swagger-ui/index.html")).andExpect(status().isOk());
    }
}
