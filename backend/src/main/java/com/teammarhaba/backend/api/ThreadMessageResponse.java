package com.teammarhaba.backend.api;

import com.teammarhaba.backend.chat.Message;
import java.time.Instant;
import java.util.List;

/**
 * One live message in a thread as the read projection carries it (TM-461) — the message fields plus
 * its {@link EmojiReactionCount reaction summary}. This is the thread-messages read path the AC calls
 * for: each message's {@code emoji → count} tally, with a per-emoji "did the caller react" flag, so
 * the timeline renders reaction chips inline. Built by
 * {@link com.teammarhaba.backend.chat.MessageReactionService#threadMessages}.
 *
 * <p>Only live messages appear (the read filters moderation soft-deletes), and {@code senderId} is
 * {@code null} for a system / admin "from TeamMarhaba" message.
 *
 * @param id        the message id
 * @param senderId  the author's {@code users.id}; {@code null} = a system / admin message
 * @param body      the message text
 * @param deepLink  optional in-app route the message opens; {@code null} if none
 * @param createdAt DB-authoritative post instant — the in-thread order
 * @param reactions the message's reaction summary, oldest-reacted emoji first; empty if none
 */
public record ThreadMessageResponse(
        Long id,
        Long senderId,
        String body,
        String deepLink,
        Instant createdAt,
        List<EmojiReactionCount> reactions) {

    /** Project a {@link Message} plus its already-computed reaction summary into the read DTO. */
    public static ThreadMessageResponse from(Message message, List<EmojiReactionCount> reactions) {
        return new ThreadMessageResponse(
                message.getId(),
                message.getSenderId(),
                message.getBody(),
                message.getDeepLink(),
                message.getCreatedAt(),
                reactions);
    }
}
