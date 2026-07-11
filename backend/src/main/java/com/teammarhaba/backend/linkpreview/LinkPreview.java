package com.teammarhaba.backend.linkpreview;

/**
 * The result of resolving a link preview for a URL (TM-470) — the OpenGraph card fields the chat thread
 * renders under a message that contains a link. All the metadata fields are <b>nullable</b>: a page may
 * expose only some (or none) of them, and a fetch that failed or returned no usable metadata yields an
 * {@linkplain #empty(String) empty} preview (just the {@code url}). The client renders a card only when
 * there is at least a title, and otherwise leaves the raw URL as plain text — the AC's "fall back to a
 * plain link on fetch failure".
 *
 * <p>This is a pure value object with no network or Spring coupling, produced by {@link OpenGraphParser}
 * and cached/served by {@link LinkPreviewService}. {@code imageUrl} has already been resolved to an
 * absolute {@code http}/{@code https} URL (or dropped) by the parser, so the client never has to.
 *
 * @param url the URL the preview is for (echoed back so the client can match it to the message link).
 * @param title the OpenGraph/HTML title, or {@code null}.
 * @param description the OpenGraph/meta description, or {@code null}.
 * @param imageUrl an absolute http(s) preview image URL, or {@code null}.
 */
public record LinkPreview(String url, String title, String description, String imageUrl) {

    /** A preview carrying only the URL — no metadata resolved (fetch failed, or the page exposed none). */
    public static LinkPreview empty(String url) {
        return new LinkPreview(url, null, null, null);
    }

    /**
     * Whether this preview carries anything worth rendering a card for. A title is the minimum: a card
     * with only an image or only a description reads as broken, so the client treats a title-less preview
     * as "no preview" and shows the plain link instead.
     */
    public boolean hasContent() {
        return title != null && !title.isBlank();
    }
}
