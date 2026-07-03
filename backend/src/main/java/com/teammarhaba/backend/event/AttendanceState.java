package com.teammarhaba.backend.event;

/**
 * State of one user's attendance on one event (TM-391). Stored as VARCHAR via
 * {@code EnumType.STRING} (same convention as {@code users.role}).
 *
 * <p>There is no "declined" state: leaving an event deletes the {@link EventAttendance} row
 * outright — the {@code UNIQUE (event_id, user_id)} pair then lets a rejoin re-insert cleanly at
 * the back of the queue.
 */
public enum AttendanceState {

    /** Holds one of the event's capacity slots (or any slot, when capacity is unlimited). */
    GOING,

    /** Queued FIFO (by {@code created_at}) for a slot on a full event. */
    WAITLISTED
}
