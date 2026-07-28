package com.teammarhaba.backend.chat;

/**
 * How much of a {@link Conversation}'s history a member may read (TM-1055, chat-media foundation).
 * Stored on the {@code conversation} row by {@code name()} via {@code EnumType.STRING} (same
 * convention as {@link ConversationType} / {@code conversation_member.mute} / {@code users.role}), so
 * values may be added but existing names must never be renamed/removed — old rows keep referencing them.
 *
 * <p><b>Phase-1 seam only.</b> Every thread is {@link #FULL} today (the column defaults to it, V51), so
 * this enum introduces the vocabulary the read path branches on without changing any behaviour: {@link
 * ConversationReadService#messages} reads the flag but, with only {@code FULL} in play, returns the whole
 * thread exactly as before. Phase 2 (epic TM-468) implements {@link #FROM_JOIN} — the member sees only
 * messages from their join onward — plus the {@code history_cutoff_at} it needs; neither is built here.
 *
 * <ul>
 *   <li>{@link #FULL} — the member reads the WHOLE thread timeline, pre-join messages included. Today's
 *       behaviour and the default for every existing and new thread (the TM-709 late-joiner guarantee).
 *   <li>{@link #FROM_JOIN} — <b>Phase 2, not yet honoured.</b> The member sees only messages posted from
 *       their join onward. Reserved here so the read path is already aware of the flag; no thread is ever
 *       set to it in Phase 1, and the read path treats it identically to {@code FULL} until Phase 2 adds
 *       the join-scoped filter.
 * </ul>
 */
public enum HistoryVisibility {

    /** The member reads the whole thread timeline, pre-join messages included — today's behaviour, the default. */
    FULL,

    /** Phase 2 (TM-468): the member sees only messages from their join onward. Reserved; not yet honoured. */
    FROM_JOIN
}
