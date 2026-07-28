package com.teammarhaba.backend.api;

import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;
import org.springframework.util.StringUtils;

/**
 * Body for {@code POST /api/v1/conversations/{conversationId}/messages} (TM-447, epic Event Chat) —
 * an event attendee posting a chat message to the event's group thread.
 *
 * <p>Bounded by Bean Validation so a malformed body is a uniform RFC-7807 {@code 400} (with a
 * per-field {@code errors[]}) rather than a {@code 500}, mirroring {@link AdminMessageRequest} /
 * {@link ReactionRequest}:
 *
 * <ul>
 *   <li>{@code body} — the message text, at most {@value #MAX_BODY_LENGTH} characters (the chat length
 *       cap from the ticket clarification, enforced client-side too but the server is the authority).
 *       <b>No longer {@code @NotBlank}</b> (TM-1125): a chat-media message may be attachment-only (a bare
 *       photo or voice note with no caption), so an empty body is allowed <em>as long as an
 *       {@code attachmentPath} is present</em>. The "must carry SOMETHING" rule is the cross-field
 *       {@link #isBodyOrAttachmentPresent()} below, so a truly empty message (no text AND no attachment)
 *       is still a {@code 400}.</li>
 *   <li>{@code attachmentPath} — OPTIONAL (TM-1125): the Firebase Storage object path of a media
 *       attachment (image / voice / video-later) this message carries; {@code null} for a plain text
 *       message. {@code @Size(max = 512)} matches the {@code message.attachment_path} column (V51) and
 *       the {@code venue.photo_path} convention.</li>
 *   <li>{@code mediaType} — OPTIONAL (TM-1125): a short discriminator of what {@code attachmentPath} IS
 *       (e.g. {@code "image"}, {@code "voice"}, {@code "video"}), so the client renders the right bubble;
 *       {@code null} for a text-only message. {@code @Size(max = 16)} matches the {@code message.media_type}
 *       column (V51).</li>
 *   <li>{@code replyToMessageId} — OPTIONAL (TM-466): the id of an earlier message in the same thread
 *       this one replies to; {@code null} for a normal message. {@code @Positive} rejects a garbage
 *       {@code 0}/negative id at the edge, but that the id names a <em>live, same-thread</em> message
 *       is a stateful check the service does (a foreign / deleted target is a {@code 400} there),
 *       since Bean Validation can't reach the database.</li>
 * </ul>
 *
 * @param body             the message text; up to {@value #MAX_BODY_LENGTH} characters. May be blank ONLY
 *                         when an {@code attachmentPath} is present (an attachment-only message, TM-1125).
 * @param attachmentPath   the media attachment's Firebase Storage object path (TM-1125); {@code null} for a
 *                         plain text message.
 * @param mediaType        the attachment's media-kind discriminator (TM-1125); {@code null} for a text-only
 *                         message.
 * @param replyToMessageId the message being replied to (TM-466); {@code null} for a non-reply message.
 */
public record PostMessageRequest(
        @Size(max = MAX_BODY_LENGTH) String body,
        @Size(max = MAX_ATTACHMENT_PATH_LENGTH) String attachmentPath,
        @Size(max = MAX_MEDIA_TYPE_LENGTH) String mediaType,
        @Positive Long replyToMessageId) {

    /**
     * Max chat-message length (TM-447 clarification: "~500 characters max", validated client + server).
     * The {@code message.body} column is {@code VARCHAR(4000)} (migration V27), so this 500-char cap is
     * the tighter limit that actually applies.
     */
    public static final int MAX_BODY_LENGTH = 500;

    /** Max attachment object-path length — matches the {@code message.attachment_path} column (V51). */
    public static final int MAX_ATTACHMENT_PATH_LENGTH = 512;

    /** Max media-type discriminator length — matches the {@code message.media_type} column (V51). */
    public static final int MAX_MEDIA_TYPE_LENGTH = 16;

    /** Convenience for a plain (non-reply, non-attachment) text message — the common case. */
    public PostMessageRequest(String body) {
        this(body, null, null, null);
    }

    /** Convenience for a reply with no attachment (keeps the TM-466 call sites unchanged). */
    public PostMessageRequest(String body, Long replyToMessageId) {
        this(body, null, null, replyToMessageId);
    }

    /**
     * A message must carry SOMETHING (TM-1125): real body text OR a media attachment. This replaces the
     * old {@code @NotBlank body} — a blank body is fine for an attachment-only message, but a request with
     * neither text nor an attachment is an empty message and a uniform {@code 400}. Kept as an
     * {@code @AssertTrue} property so it reports through the same per-field validation body; anchored on
     * the {@code body} field so the client highlights the text input.
     */
    @JsonIgnore
    @AssertTrue(message = "a message must have a body or an attachment")
    public boolean isBodyOrAttachmentPresent() {
        return StringUtils.hasText(body) || StringUtils.hasText(attachmentPath);
    }
}
