package com.teammarhaba.backend.api;

import com.teammarhaba.backend.chat.Message;

/**
 * The quoted-parent snippet a reply carries in the thread projection (TM-466) — the small preview the
 * chat view renders ABOVE a reply so a busy event thread reads clearly. Rides inside {@link
 * ConversationMessageResponse#replyTo()}; {@code null} there for a normal (non-reply) message.
 *
 * <p>Deliberately a <em>snippet</em>, not the whole parent {@link ConversationMessageResponse}: it
 * carries only what the quote UI needs (who wrote it + a short excerpt) and is capped at {@value
 * #EXCERPT_MAX} characters so the wire payload of a long reply chain can't balloon.
 *
 * <p><b>The "message unavailable" branch</b> (the AC): if the parent has since been moderation
 * soft-deleted (or is somehow missing), the excerpt is withheld and {@code available} is {@code false}
 * so the client renders a neutral "message unavailable" placeholder instead of leaking removed text.
 * {@code id} is still carried in that case so the reply keeps its provenance (and a tap-to-scroll can
 * still resolve to the row if it's on screen).
 *
 * @param id        the quoted (parent) message's id — always present, even when unavailable
 * @param senderId  the parent author's {@code users.id}; {@code null} = a system message, or unavailable
 * @param system    convenience: the parent was a system / admin "from TeamMarhaba" message
 * @param excerpt   a short, whitespace-collapsed excerpt of the parent body; {@code null} when unavailable
 * @param available {@code true} if the parent is still live; {@code false} = removed / missing ("unavailable")
 */
public record QuotedMessage(Long id, Long senderId, boolean system, String excerpt, boolean available) {

    /** Max length of the quoted excerpt — long parents are truncated with an ellipsis. */
    public static final int EXCERPT_MAX = 140;

    /** The single character appended when a parent body is truncated to {@link #EXCERPT_MAX}. */
    private static final char ELLIPSIS = '…';

    /**
     * The quoted snippet of a still-live parent: its author + a short, whitespace-collapsed excerpt of
     * its body (truncated to {@link #EXCERPT_MAX} with an ellipsis).
     */
    public static QuotedMessage of(Message parent) {
        return new QuotedMessage(
                parent.getId(), parent.getSenderId(), parent.isSystem(), excerptOf(parent.getBody()), true);
    }

    /**
     * The "message unavailable" snippet for a parent that has been moderation-removed or is missing —
     * keeps the id (so provenance / tap-to-scroll survive) but withholds the author + excerpt.
     */
    public static QuotedMessage unavailable(Long id) {
        return new QuotedMessage(id, null, false, null, false);
    }

    /**
     * Resolve the snippet for a reply whose parent is {@code parent} (looked up by {@code replyToId}):
     * {@code null} when this isn't a reply, {@link #unavailable} when the parent is gone or soft-deleted,
     * otherwise {@link #of the live snippet}. The single place the "is the quote still available?" rule
     * lives, shared by the thread read and the post echo.
     *
     * @param replyToId the reply target's id, or {@code null} if the message is not a reply
     * @param parent    the resolved parent {@link Message}, or {@code null} if it couldn't be found
     */
    public static QuotedMessage resolve(Long replyToId, Message parent) {
        if (replyToId == null) {
            return null; // not a reply
        }
        return (parent == null || parent.isDeleted()) ? unavailable(replyToId) : of(parent);
    }

    /** Collapse internal whitespace to single spaces, trim, and cap the length with an ellipsis. */
    private static String excerptOf(String body) {
        String collapsed = String.valueOf(body).strip().replaceAll("\\s+", " ");
        if (collapsed.length() <= EXCERPT_MAX) {
            return collapsed;
        }
        // Truncate to EXCERPT_MAX total chars: EXCERPT_MAX-1 of text + the ellipsis, trimming any
        // trailing space so the cut never reads as "word …".
        return collapsed.substring(0, EXCERPT_MAX - 1).stripTrailing() + ELLIPSIS;
    }
}
