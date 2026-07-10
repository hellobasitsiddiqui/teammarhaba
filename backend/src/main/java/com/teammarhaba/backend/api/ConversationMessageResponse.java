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
 * <p><b>{@code mine}</b> is the server-computed own-message flag (TM-589) — {@code true} when this
 * message's {@code senderId} equals the <em>verified</em> caller's resolved {@code users.id}, so the
 * thread UI (TM-448) can align the caller's own messages out-going (right) vs. others' incoming (left)
 * and show read ticks on its own, without the client ever supplying — or having to know — its own numeric
 * id. Identity is strictly server-derived from the token (see {@link
 * com.teammarhaba.backend.chat.ConversationReadService#messages}), never client-asserted. A system /
 * admin message ({@code senderId == null}) is never the caller's, so {@code mine == false} there.
 *
 * <p><b>{@code mine} is nullable on purpose</b>, mirroring {@code readReceipt} / {@code replyTo}: it is
 * {@code null} <em>only</em> on the caller-independent SSE broadcast frame (TM-464), which fans one
 * payload out to every connected member and so has no single caller to resolve "mine" against. The
 * thread read and the poster's own POST echo always carry a concrete {@code true} / {@code false}; a
 * live subscriber re-syncs the authoritative value from the read API. Clients treat {@code mine == true}
 * as own and anything else ({@code false} or the broadcast's {@code null}) as other.
 *
 * @param id          the message's surrogate id
 * @param senderId    the author's {@code users.id}; {@code null} = a system / admin message
 * @param system      convenience: {@code senderId == null} — drives the "from TeamMarhaba" render
 * @param mine        server-computed: {@code senderId == the verified caller's id} (TM-589) — drives
 *                    own-vs-other alignment; {@code null} only on the caller-independent broadcast frame
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
        Boolean mine,
        String body,
        String deepLink,
        Instant createdAt,
        List<EmojiReactionCount> reactions,
        MessageReadReceipt readReceipt,
        QuotedMessage replyTo) {

    /**
     * Map a persisted {@link Message} plus its reaction summary, (nullable) read receipt, (nullable)
     * quoted-parent snippet and the caller-context {@code mine} flag to its wire form. {@code
     * readReceipt} is {@code null} unless the message is the caller's own; {@code replyTo} is {@code
     * null} for a non-reply message; {@code mine} is the server-computed own-message flag (TM-589) —
     * {@code true} when the message's sender is the verified caller, or {@code null} on the
     * caller-independent broadcast that can't resolve it. This full overload is the one the thread read
     * (which resolves all of them per page, no N+1) and the POST echo (empty receipt + resolved quote +
     * {@code mine == true}, since a poster's own message is definitionally theirs) call.
     */
    public static ConversationMessageResponse from(
            Message message,
            List<EmojiReactionCount> reactions,
            MessageReadReceipt readReceipt,
            QuotedMessage replyTo,
            Boolean mine) {
        return new ConversationMessageResponse(
                message.getId(),
                message.getSenderId(),
                message.isSystem(),
                mine,
                message.getBody(),
                message.getDeepLink(),
                message.getCreatedAt(),
                reactions,
                readReceipt,
                replyTo);
    }

    /**
     * Convenience overload for the paths that can't resolve a per-caller receipt, the quoted parent, or
     * the {@code mine} flag: the SSE live-broadcast (TM-464), whose single payload fans out to every
     * connected member and so can't carry one member's private "read by" view — nor whose message is
     * "mine" — and whose post-commit hook doesn't re-load the reply parent. Maps with {@code readReceipt
     * == null} ("not resolved / not yours"), {@code replyTo == null} AND {@code mine == null} ("not
     * resolved — caller-independent frame"); a subscriber that turns out to be the sender still gets the
     * authoritative receipt, reply quote and {@code mine} value from the read API (and from its own POST
     * echo), so nothing is lost by omitting them from the broadcast frame.
     */
    public static ConversationMessageResponse from(Message message, List<EmojiReactionCount> reactions) {
        return from(message, reactions, null, null, null);
    }
}
