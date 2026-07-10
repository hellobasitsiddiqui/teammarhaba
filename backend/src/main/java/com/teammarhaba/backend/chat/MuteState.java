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
 *   <li>{@code NONE} — active member: reads, posts, and receives push for new messages. A member who
 *       has <em>self-muted</em> (TM-471) is still {@code NONE} — mute-of-notifications is an orthogonal
 *       per-member boolean ({@code notificationsMuted}), not a state here, precisely because a
 *       self-muted member must stay a full active member (reads AND posts) with only push suppressed.
 *   <li>{@code READ_ONLY} — may read but not post (organiser-restricted / admin-muted), and receives
 *       no push.
 *   <li>{@code LEFT} — the member <em>self-left</em> the thread (TM-471) while still attending the
 *       event (their RSVP is unchanged). Like {@code REMOVED} it hides the thread and drops them from
 *       reads/roster/push, but it is deliberately DISTINCT from {@code REMOVED} in two ways: (1) a
 *       self-left member may bring themselves back via the member-facing rejoin endpoint, whereas a
 *       kicked ({@code REMOVED}) member may not; and (2) the RSVP→membership re-sync
 *       ({@code EventChatLifecycleService}) treats a self-leave as <b>sticky</b> — it never silently
 *       reactivates a {@code LEFT} member on the next GOING landing (whereas it does reactivate a
 *       {@code REMOVED} one, which is the un-RSVP→re-RSVP path). So leaving the chat is not undone by
 *       re-confirming attendance; only an explicit rejoin returns them.
 *   <li>{@code REMOVED} — kicked from the thread by moderation (or dropped by un-RSVPing the event).
 *       The row is kept (not deleted) so a re-add is clean and the fan-out (TM-437) can cheaply skip
 *       them; a removed member neither reads new content nor receives push, and cannot self-rejoin.
 * </ul>
 */
public enum MuteState {

    /** Active member — reads, posts, and is included in push fan-out (subject to self-mute of push). */
    NONE,

    /** May read but not post; excluded from push. */
    READ_ONLY,

    /**
     * The member self-left the thread (TM-471) but still attends the event — hidden from reads/roster
     * /push like {@link #REMOVED}, yet self-reversible (rejoin) and sticky against RSVP re-sync.
     */
    LEFT,

    /** Kicked from the thread; kept as a row but excluded from reads and push; not self-reversible. */
    REMOVED
}
