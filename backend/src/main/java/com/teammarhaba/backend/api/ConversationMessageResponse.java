package com.teammarhaba.backend.api;

import com.teammarhaba.backend.chat.Message;
import java.time.Instant;
import java.util.List;

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
 * <p><b>{@code reactions}</b> is the message's reaction summary (TM-461) — one {@link EmojiReactionCount}
 * per distinct emoji (reactor count + whether the caller reacted), oldest-reacted emoji first, so the
 * timeline renders reaction chips inline without a second round-trip; empty when nothing has been
 * reacted. The single thread-read endpoint carries it so reactions ride the same page as the messages.
 *
 * <p><b>{@code readReceipt}</b> is the read receipt (TM-463) — present <b>only</b> on the caller's own
 * messages (privacy: only the sender sees who's read their message), so a {@code null} {@code
 * readReceipt} means "not yours". Its {@code count} + {@code readerIds} are derived from members'
 * {@code last_read_at} cursors and ride the same page (computed without an N+1). See {@link
 * MessageReadReceipt}.
 *
 * <p><b>{@code replyTo}</b> is the quoted-parent snippet (TM-466) — present <b>only</b> when this
 * message is a reply, {@code null} otherwise. It carries just what the quote UI needs (author + a short
 * excerpt, or an "unavailable" marker when the parent was removed) and, like reactions and the receipt,
 * rides the same page (batch-resolved, no N+1). See {@link QuotedMessage}.
 *
 * @param id          the message's surrogate id
 * @param senderId    the author's {@code users.id}; {@code null} = a system / admin message
 * @param system      convenience: {@code senderId == null} — drives the "from TeamMarhaba" render
 * @param body        the message text
 * @param deepLink    optional in-app route the message opens (e.g. {@code /events/42}); {@code null} if none
 * @param createdAt   DB-authoritative post instant — the in-thread (chronological) order
 * @param reactions   the message's reaction summary, oldest-reacted emoji first; empty if none
 * @param readReceipt read receipt for the caller's OWN message (count + reader ids); {@code null} if not theirs
 * @param replyTo     the quoted parent snippet when this is a reply (TM-466); {@code null} otherwise
 */
public record ConversationMessageResponse(
        Long id,
        Long senderId,
        boolean system,
        String body,
        String deepLink,
        Instant createdAt,
        List<EmojiReactionCount> reactions,
        MessageReadReceipt readReceipt,
        QuotedMessage replyTo) {

    /**
     * Map a persisted {@link Message} plus its reaction summary, (nullable) read receipt and (nullable)
     * quoted-parent snippet to its wire form. {@code readReceipt} is {@code null} unless the message is
     * the caller's own; {@code replyTo} is {@code null} for a non-reply message. This full overload is
     * the one the thread read (which resolves both per page, no N+1) and the POST echo (empty receipt +
     * resolved quote) call.
     */
    public static ConversationMessageResponse from(
            Message message,
            List<EmojiReactionCount> reactions,
            MessageReadReceipt readReceipt,
            QuotedMessage replyTo) {
        return new ConversationMessageResponse(
                message.getId(),
                message.getSenderId(),
                message.isSystem(),
                message.getBody(),
                message.getDeepLink(),
                message.getCreatedAt(),
                reactions,
                readReceipt,
                replyTo);
    }

    /**
     * Convenience overload for the paths that can't resolve a per-caller receipt or the quoted parent:
     * the SSE live-broadcast (TM-464), whose single payload fans out to every connected member and so
     * can't carry one member's private "read by" view, and whose post-commit hook doesn't re-load the
     * reply parent. Maps with {@code readReceipt == null} ("not resolved / not yours") AND {@code
     * replyTo == null}; a subscriber that turns out to be the sender still gets the authoritative receipt
     * — and any reply quote — from the read API (and from its own POST echo), so nothing is lost by
     * omitting them from the broadcast frame.
     */
    public static ConversationMessageResponse from(Message message, List<EmojiReactionCount> reactions) {
        return from(message, reactions, null, null);
    }
}
