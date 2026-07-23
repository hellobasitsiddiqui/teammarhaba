package com.teammarhaba.backend.chat;

import java.util.Collection;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

/**
 * Data access for {@link MessageReaction} (TM-461) — the toggle idempotency checks and the per-message
 * reaction summary the thread read projection carries.
 *
 * <p>Every lookup is served by the {@code UNIQUE (message_id, user_id, emoji)} index (its
 * {@code message_id} prefix covers the summary reads), so no extra index is needed:
 *
 * <ul>
 *   <li>{@link #existsByMessageIdAndUserIdAndEmoji} — the react toggle-on guard (already reacted → no-op).
 *   <li>{@link #deleteByMessageIdAndUserIdAndEmoji} — the un-react toggle-off (idempotent: 0 rows if absent).
 *   <li>{@link #findByMessageIdOrderByCreatedAtAscIdAsc} — a single message's reactions, first-reacted
 *       first, to build its {@code emoji → count (+ did the caller react)} summary.
 *   <li>{@link #findByMessageIdInOrderByCreatedAtAscIdAsc} — the same, batched across a page of messages,
 *       so the thread-messages read builds every summary in one query (no N+1).
 * </ul>
 */
public interface MessageReactionRepository extends JpaRepository<MessageReaction, Long> {

    /** Whether this member has already reacted to this message with this emoji — the toggle-on guard. */
    boolean existsByMessageIdAndUserIdAndEmoji(Long messageId, Long userId, String emoji);

    /**
     * How many distinct reactions this member already has on this message — the per-user-per-message
     * cap check on the react (add) path (TM-989). Because {@code UNIQUE (message_id, user_id, emoji)}
     * makes every one of a member's rows on a message a distinct emoji, a plain row count is the
     * distinct-emoji count; add-path only, so un-react is never blocked.
     */
    long countByMessageIdAndUserId(Long messageId, Long userId);

    /**
     * Remove this member's reaction with this emoji from this message (the un-react toggle-off).
     * Derived delete: idempotent — deletes 0 rows if the reaction isn't there, so a double un-react
     * is a harmless no-op. Returns the number of rows removed (0 or 1). Runs in the caller's
     * transaction (the service is {@code @Transactional}).
     */
    long deleteByMessageIdAndUserIdAndEmoji(Long messageId, Long userId, String emoji);

    /** One message's reactions, oldest-reacted first — the stable chip order for its summary. */
    List<MessageReaction> findByMessageIdOrderByCreatedAtAscIdAsc(Long messageId);

    /** Reactions across a set of messages, oldest-reacted first — the batched summary for a thread page. */
    List<MessageReaction> findByMessageIdInOrderByCreatedAtAscIdAsc(Collection<Long> messageIds);
}
