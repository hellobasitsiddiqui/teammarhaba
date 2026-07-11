package com.teammarhaba.backend.api;

import com.teammarhaba.backend.linkpreview.LinkPreview;
import com.teammarhaba.backend.linkpreview.LinkPreviewService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The link-preview read endpoint (TM-470), under {@code /api/v1/link-preview} (the {@code /api/v1} prefix
 * is applied by {@link ApiV1Config}).
 *
 * <ul>
 *   <li>{@code GET /link-preview?url=…} — fetch the OpenGraph card for {@code url} and return it. The
 *       chat client calls this lazily when a message that contains a link renders, so the preview is
 *       fetched <b>server-side</b> (behind the SSRF guard in {@link LinkPreviewService}) and the browser
 *       never makes the outbound request.</li>
 * </ul>
 *
 * <p><b>Authenticated by design.</b> This route carries no {@code SecurityConfig} permit-list entry, so
 * it falls under the default-deny rule (TM-79): only a signed-in user (a chat participant viewing a
 * thread) can request a preview. A malformed/disallowed/internal-address URL yields a 400 (via
 * {@link com.teammarhaba.backend.web.BadRequestException}); a reachable URL with no usable metadata
 * yields a 200 with null fields, and the client simply shows the plain link.
 */
@RestController
public class LinkPreviewController {

    private final LinkPreviewService linkPreviews;

    LinkPreviewController(LinkPreviewService linkPreviews) {
        this.linkPreviews = linkPreviews;
    }

    /** Fetch (or serve cached) the OpenGraph preview for {@code url}. */
    @GetMapping("/link-preview")
    public LinkPreviewResponse preview(@RequestParam("url") String url) {
        LinkPreview preview = linkPreviews.preview(url);
        return LinkPreviewResponse.from(preview);
    }
}
