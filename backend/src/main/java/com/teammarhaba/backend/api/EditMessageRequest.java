package com.teammarhaba.backend.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code PATCH /api/v1/conversations/{conversationId}/messages/{messageId}} (TM-467, epic
 * Event Chat) — an author editing their OWN chat message to fix a typo or reword it.
 *
 * <p>The replacement text is bounded by Bean Validation on exactly the same rule as a fresh post
 * ({@link PostMessageRequest#MAX_BODY_LENGTH}), so an edited body can never be blank or longer than a
 * message could have been posted in the first place — a malformed edit is a uniform RFC-7807
 * {@code 400} (with a per-field {@code errors[]}) rather than a {@code 500}. The stateful gates that
 * Bean Validation can't reach — the author-only ownership check ({@code 403} for anyone else), the
 * open-thread check ({@code 409} on a closed thread), and the ~5-minute edit window ({@code 409} once
 * it's locked) — are enforced by {@link com.teammarhaba.backend.chat.MessageAuthorService}.
 *
 * @param body the replacement message text; required, non-blank, up to
 *     {@value PostMessageRequest#MAX_BODY_LENGTH} characters (the shared chat length cap).
 */
public record EditMessageRequest(@NotBlank @Size(max = PostMessageRequest.MAX_BODY_LENGTH) String body) {}
