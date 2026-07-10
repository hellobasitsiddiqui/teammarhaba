package com.teammarhaba.backend.api;

import java.util.List;

/**
 * The read receipt on the caller's OWN message (TM-463): how many <em>other</em> current members have
 * read it, plus their ids so the client can render the "read by N → who" list. Attached to a {@link
 * ConversationMessageResponse} <b>only</b> where the caller is the sender — a {@code null} {@code
 * readReceipt} on a message means "not yours", which is also the client's authoritative "this message
 * is mine" signal (the read API otherwise doesn't expose the caller's own numeric id).
 *
 * <p><b>Derived, not stored (no new table).</b> "Read" is computed from the existing per-member {@code
 * last_read_at} cursors (TM-436): a member has read a message when their cursor is at/after the
 * message's {@code created_at}. The sender is never counted as a reader of their own message.
 *
 * <p><b>Group semantics (documented in the AC).</b> The reader set is the thread's <em>current</em>
 * non-removed members (a kicked member drops out — {@code count} reflects the live membership) who
 * were <em>already in the thread when the message was posted</em> — a member who joins later can't
 * retro-change a past message's count, even once their cursor sweeps past it. A {@link
 * com.teammarhaba.backend.chat.MuteState#READ_ONLY} member still reads, so they count.
 *
 * @param count     how many other current members have read the message ({@code >= 0}); equals {@code
 *                  readerIds.size()}
 * @param readerIds the {@code users.id}s of those readers, ascending — the "who has read it" list
 */
public record MessageReadReceipt(long count, List<Long> readerIds) {

    /** A receipt with no readers yet — e.g. a just-posted message nobody else could have read. */
    public static MessageReadReceipt empty() {
        return new MessageReadReceipt(0, List.of());
    }

    /** Build a receipt from the resolved reader ids, keeping {@code count} in step with the list. */
    public static MessageReadReceipt of(List<Long> readerIds) {
        List<Long> ids = readerIds == null ? List.of() : List.copyOf(readerIds);
        return new MessageReadReceipt(ids.size(), ids);
    }
}
