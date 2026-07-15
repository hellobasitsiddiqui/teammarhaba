package com.teammarhaba.backend.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code POST /api/v1/conversations/{conversationId}/announcements} (TM-710, epic Event Chat)
 * — an admin/host posting an ANNOUNCEMENT-kind message to an event's group thread. The write path is
 * gated {@code @PreAuthorize("hasRole('ADMIN')")} at the controller, so only an admin ever reaches it.
 *
 * <p>Bounded by Bean Validation so a malformed body is a uniform RFC-7807 {@code 400} (with a per-field
 * {@code errors[]}) rather than a {@code 500}, matching {@link PostMessageRequest}. There is no
 * {@code replyToMessageId}: an announcement is a top-level post, never a reply.
 *
 * @param body the announcement text; required, non-blank, up to {@value PostMessageRequest#MAX_BODY_LENGTH}
 *     characters (the same chat length cap the ordinary post uses).
 */
public record PostAnnouncementRequest(@NotBlank @Size(max = PostMessageRequest.MAX_BODY_LENGTH) String body) {}
