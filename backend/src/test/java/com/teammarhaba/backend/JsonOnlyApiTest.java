package com.teammarhaba.backend;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.auth.VerifiedUser;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;

/**
 * The API is JSON-only (TM-126): a request that prefers XML (`Accept: application/xml`, as every
 * browser sends) still gets JSON, not `<Map>…</Map>`. Covers the public probe (`/health`) and an
 * authenticated `/api/v1` endpoint (`/ping`).
 */
@AutoConfigureMockMvc
class JsonOnlyApiTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void healthIsJsonEvenWhenXmlRequested() throws Exception {
        mockMvc.perform(get("/health").accept(MediaType.APPLICATION_XML))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.status").value("UP"));
    }

    @Test
    void apiIsJsonEvenWhenXmlRequested() throws Exception {
        var auth = new UsernamePasswordAuthenticationToken(
                new VerifiedUser("uid-json", "x@example.com"), null, List.of());

        mockMvc.perform(get("/api/v1/ping").accept(MediaType.APPLICATION_XML).with(authentication(auth)))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON));
    }
}
