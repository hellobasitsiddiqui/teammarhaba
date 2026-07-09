package com.teammarhaba.backend.chat;

/**
 * A member's mute / removal state within one {@link Conversation} (TM-435). Stored on the
 * {@code conversation_member} row via {@code EnumType.STRING} (same convention as {@code
 * users.role}), {@code DEFAULT 'NONE'}, so values may be added but existing names must never be
 * renamed/removed.
 *
 * <p>The moderation / notification lever the chat epics (TM-432 / TM-433) drive; the transitions
 * are enforced in the service layer, not by the DB.
 *
 * <ul>
 *   <li>{@code NONE} — active member: reads, posts, and receives push for new messages.
 *   <li>{@code READ_ONLY} — may read but not post (muted/organiser-restricted), and receives no push.
 *   <li>{@code REMOVED} — kicked from the thread. The row is kept (not deleted) so a re-add is clean
 *       and the fan-out (TM-437) can cheaply skip them; a removed member neither reads new content
 *       nor receives push.
 * </ul>
 */
public enum MuteState {

    /** Active member — reads, posts, and is included in push fan-out. */
    NONE,

    /** May read but not post; excluded from push. */
    READ_ONLY,

    /** Kicked from the thread; kept as a row but excluded from reads and push. */
    REMOVED
}
