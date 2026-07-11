package com.teammarhaba.backend.api;

import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.linkpreview.LinkPreview;
import com.teammarhaba.backend.linkpreview.LinkPreviewService;
import com.teammarhaba.backend.web.BadRequestException;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Web-slice tests for the link-preview endpoint (TM-470). The {@link LinkPreviewService} is mocked (the
 * outbound fetch + SSRF guard are covered by {@code LinkPreviewServiceTest}); this asserts the HTTP
 * contract: the {@code /api/v1} prefix, the {@code url} param binding, the JSON mapping, and that a
 * rejected URL surfaces as an RFC 7807 400. Filters are off so the slice exercises the controller, not
 * the default-deny auth chain (the route is authenticated in the full app by {@code SecurityConfig}).
 */
@WebMvcTest(LinkPreviewController.class)
@Import(ApiV1Config.class)
@AutoConfigureMockMvc(addFilters = false)
class LinkPreviewControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private LinkPreviewService linkPreviewService;

    @Test
    void returnsPreviewCardJson() throws Exception {
        when(linkPreviewService.preview("https://example.com/post"))
                .thenReturn(new LinkPreview(
                        "https://example.com/post", "A Title", "A description", "https://cdn.example.com/i.png"));

        mockMvc.perform(get("/api/v1/link-preview").param("url", "https://example.com/post"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.url").value("https://example.com/post"))
                .andExpect(jsonPath("$.title").value("A Title"))
                .andExpect(jsonPath("$.description").value("A description"))
                .andExpect(jsonPath("$.imageUrl").value("https://cdn.example.com/i.png"));
    }

    @Test
    void reachableUrlWithNoMetadataReturnsNullFields() throws Exception {
        when(linkPreviewService.preview(anyString()))
                .thenReturn(LinkPreview.empty("https://example.com/plain"));

        mockMvc.perform(get("/api/v1/link-preview").param("url", "https://example.com/plain"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.url").value("https://example.com/plain"))
                .andExpect(jsonPath("$.title").doesNotExist());
    }

    @Test
    void rejectedUrlReturns400ProblemDetail() throws Exception {
        when(linkPreviewService.preview(anyString()))
                .thenThrow(new BadRequestException("That URL points to a non-public address and can't be previewed."));

        mockMvc.perform(get("/api/v1/link-preview").param("url", "http://127.0.0.1/"))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Bad request"))
                .andExpect(jsonPath("$.status").value(400));
    }

    @Test
    void missingUrlParamReturns400() throws Exception {
        mockMvc.perform(get("/api/v1/link-preview")).andExpect(status().isBadRequest());
    }
}
