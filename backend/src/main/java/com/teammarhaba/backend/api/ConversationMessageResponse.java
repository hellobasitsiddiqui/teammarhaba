package com.teammarhaba.backend.api;

import com.teammarhaba.backend.chat.Message;
import java.time.Instant;

/**
 * One message in a thread's timeline (TM-436) — the wire shape the chat view renders per line. A DTO,
 * never the JPA entity, so the HTTP contract is decoupled from the {@link Message} mapping and stays
 * reviewable in {@code openapi.json}.
 *
 * <p><b>Only live messages reach this DTO.</b> The thread read filters {@code deletedAt IS NULL} at
 * the query, so a moderation-removed message never surfaces here — this ticket takes the AC's
 * "excludes soft-deleted messages" branch rather than emitting a "removed" placeholder.
 *
 * <p><b>{@code senderId} is nullable</b>: {@code null} marks a system / admin "from TeamMarhaba"
 * message (an admin broadcast or an in-thread system notice), surfaced as the convenience {@code
 * system} flag so a client can render it without a null-check. A human author is resolved by the
 * client through the people surface, never assumed present in this row.
 *
 * @param id        the message's surrogate id
 * @param senderId  the author's {@code users.id}; {@code null} = a system / admin message
 * @param system    convenience: {@code senderId == null} — drives the "from TeamMarhaba" render
 * @param body      the message text
 * @param deepLink  optional in-app route the message opens (e.g. {@code /events/42}); {@code null} if none
 * @param createdAt DB-authoritative post instant — the in-thread (chronological) order
 */
public record ConversationMessageResponse(
        Long id, Long senderId, boolean system, String body, String deepLink, Instant createdAt) {

    /** Map a persisted {@link Message} to its wire form, deriving {@code system} from a null sender. */
    public static ConversationMessageResponse from(Message message) {
        return new ConversationMessageResponse(
                message.getId(),
                message.getSenderId(),
                message.isSystem(),
                message.getBody(),
                message.getDeepLink(),
                message.getCreatedAt());
    }
}
