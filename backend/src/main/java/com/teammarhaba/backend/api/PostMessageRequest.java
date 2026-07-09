package com.teammarhaba.backend.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code POST /api/v1/conversations/{conversationId}/messages} (TM-447, epic Event Chat) —
 * an event attendee posting a chat message to the event's group thread.
 *
 * <p>Bounded by Bean Validation so a malformed body is a uniform RFC-7807 {@code 400} (with a
 * per-field {@code errors[]}) rather than a {@code 500}, mirroring {@link AdminMessageRequest} /
 * {@link ReactionRequest}:
 *
 * <ul>
 *   <li>{@code body} — required, non-blank (a whitespace-only message is rejected), and at most
 *       {@value #MAX_BODY_LENGTH} characters — the chat length cap from the ticket clarification.
 *       Enforced client-side too, but the server is the authority.</li>
 *   <li>{@code replyToMessageId} — OPTIONAL (TM-466): the id of an earlier message in the same thread
 *       this one replies to; {@code null} for a normal message. {@code @Positive} rejects a garbage
 *       {@code 0}/negative id at the edge, but that the id names a <em>live, same-thread</em> message
 *       is a stateful check the service does (a foreign / deleted target is a {@code 400} there),
 *       since Bean Validation can't reach the database.</li>
 * </ul>
 *
 * @param body             the message text; required, non-blank, up to {@value #MAX_BODY_LENGTH} characters.
 * @param replyToMessageId the message being replied to (TM-466); {@code null} for a non-reply message.
 */
public record PostMessageRequest(
        @NotBlank @Size(max = MAX_BODY_LENGTH) String body, @Positive Long replyToMessageId) {

    /**
     * Max chat-message length (TM-447 clarification: "~500 characters max", validated client + server).
     * The {@code message.body} column is {@code VARCHAR(4000)} (migration V27), so this 500-char cap is
     * the tighter limit that actually applies.
     */
    public static final int MAX_BODY_LENGTH = 500;

    /** Convenience for a plain (non-reply) message — the common case. */
    public PostMessageRequest(String body) {
        this(body, null);
    }
}
