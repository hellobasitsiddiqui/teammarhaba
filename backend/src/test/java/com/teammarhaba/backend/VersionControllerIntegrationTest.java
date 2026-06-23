package com.teammarhaba.backend;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/**
 * {@code /version} (TM-142, TM-155) is public build provenance — reachable without a token (it's in
 * the security permit-list) and always reports its fields. The {@code version} (git describe),
 * {@code sha} and {@code revision} fall back to {@code dev}/{@code dev}/{@code local} when their env
 * vars are unset (i.e. outside the deployed image).
 */
@AutoConfigureMockMvc
class VersionControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void versionIsPublicAndReportsBuildProvenance() throws Exception {
        mockMvc.perform(get("/version"))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.version").value("dev")) // BUILD_VERSION unset → falls back to sha
                .andExpect(jsonPath("$.sha").value("dev")) // BUILD_SHA unset under test
                .andExpect(jsonPath("$.revision").value("local")) // K_REVISION unset under test
                .andExpect(jsonPath("$.buildTime").exists());
    }
}
