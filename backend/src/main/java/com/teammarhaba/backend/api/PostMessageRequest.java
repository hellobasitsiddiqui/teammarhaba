package com.teammarhaba.backend.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code POST /api/v1/conversations/{conversationId}/messages} (TM-447, epic Event Chat) —
 * an event attendee posting a chat message to the event's group thread.
 *
 * <p>The single field is the message text, bounded by Bean Validation so a malformed body is a
 * uniform RFC-7807 {@code 400} (with a per-field {@code errors[]}) rather than a {@code 500},
 * mirroring {@link AdminMessageRequest} / {@link ReactionRequest}:
 *
 * <ul>
 *   <li>{@code body} — required, non-blank (a whitespace-only message is rejected), and at most
 *       {@value #MAX_BODY_LENGTH} characters — the chat length cap from the ticket clarification.
 *       Enforced client-side too, but the server is the authority.</li>
 * </ul>
 *
 * @param body the message text; required, non-blank, up to {@value #MAX_BODY_LENGTH} characters.
 */
public record PostMessageRequest(@NotBlank @Size(max = MAX_BODY_LENGTH) String body) {

    /**
     * Max chat-message length (TM-447 clarification: "~500 characters max", validated client + server).
     * The {@code message.body} column is unbounded {@code TEXT}, so this is the only limit that applies.
     */
    public static final int MAX_BODY_LENGTH = 500;
}
