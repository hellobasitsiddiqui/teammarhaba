package com.teammarhaba.backend.event;

/**
 * The caller's own relationship to an event, as surfaced on every public read (TM-393). Unlike
 * {@link AttendanceState} (a persisted row's state), this is a view-model value: {@link #NONE}
 * means "no attendance row" — the caller hasn't RSVP'd (or has un-RSVP'd).
 */
public enum MyState {

    /** The caller has no attendance on this event. */
    NONE,

    /** The caller holds a {@code GOING} spot. */
    GOING,

    /** The caller is queued on the FIFO waitlist. */
    WAITLISTED;

    /** Map a persisted state (or {@code null} = no row) to the view-model value. */
    static MyState of(AttendanceState state) {
        if (state == null) {
            return NONE;
        }
        return state == AttendanceState.GOING ? GOING : WAITLISTED;
    }
}
