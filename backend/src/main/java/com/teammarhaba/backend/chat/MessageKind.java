package com.teammarhaba.backend.chat;

/**
 * The kind of a chat {@link Message} (TM-710) — what it <em>is</em>, orthogonal to who sent it.
 *
 * <ul>
 *   <li>{@link #ATTENDEE} — an ordinary in-thread message an attendee (or the host) posts through the
 *       normal composer. The overwhelming common case; every pre-TM-710 message is this (the {@code
 *       message.kind} column defaults to {@code ATTENDEE}, so the whole back-catalogue reads as one).
 *   <li>{@link #ANNOUNCEMENT} — an admin/host announcement posted to the event's group thread: the
 *       auto-posted event <em>opening message</em>, or a message an admin sends through the
 *       announcement endpoint. It renders visually distinct (attributed as an announcement from the
 *       host / TeamMarhaba) and is gated server-side to {@code ROLE_ADMIN} — a normal attendee post
 *       is always {@link #ATTENDEE}.
 * </ul>
 *
 * <p>Stored as its {@code name()} in {@code message.kind} ({@link jakarta.persistence.EnumType#STRING})
 * so the value is stable and human-readable in the DB, matching the house convention ({@code
 * events.status}). The kind is set once at post time and never mutated — an author edit (TM-467)
 * rewrites the body but never reclassifies the message.
 */
public enum MessageKind {
    /** An ordinary attendee/host message posted through the normal composer. */
    ATTENDEE,

    /** An admin/host announcement (the opening message, or an admin-sent announcement). */
    ANNOUNCEMENT
}
