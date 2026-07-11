package com.teammarhaba.backend.api;

import com.teammarhaba.backend.linkpreview.LinkPreview;

/**
 * The link-preview card the client renders under a chat message that contains a URL (TM-470). A thin
 * transport mirror of the domain {@link LinkPreview}: the URL echoed back (so the client can match it to
 * the message link) plus the OpenGraph fields, any of which may be {@code null}. The client shows a card
 * only when {@code title} is present and otherwise leaves the raw link as plain text.
 *
 * @param url the URL the preview is for.
 * @param title the OpenGraph/HTML title, or {@code null}.
 * @param description the OpenGraph/meta description, or {@code null}.
 * @param imageUrl an absolute http(s) preview image URL, or {@code null}.
 */
public record LinkPreviewResponse(String url, String title, String description, String imageUrl) {

    /** Map a domain preview to its API shape. */
    static LinkPreviewResponse from(LinkPreview preview) {
        return new LinkPreviewResponse(
                preview.url(), preview.title(), preview.description(), preview.imageUrl());
    }
}
