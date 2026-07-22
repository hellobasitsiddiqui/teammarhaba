package com.teammarhaba.backend.api;

import com.teammarhaba.backend.event.AttendanceState;
import com.teammarhaba.backend.event.RosterActionResult;

/**
 * The result of an admin roster action — an evict or a force-add (TM-592). Returned by
 * {@code POST /api/v1/admin/events/{id}/attendees} and
 * {@code POST /api/v1/admin/events/{id}/attendees/{userId}/evict}. Echoes the target's resulting state
 * (the {@code name()} of {@code GOING} after a force-add, {@code null} after an evict) and the event's
 * live going/waitlist counts so the console can refresh without a re-read.
 *
 * @param state    the target's attendance state after the action ({@code "GOING"}, or {@code null} = evicted)
 * @param going    the event's {@code GOING} count after the action
 * @param waitlist the event's {@code WAITLISTED} count after the action
 */
public record RosterActionResponse(String state, long going, long waitlist) {

    public static RosterActionResponse from(RosterActionResult r) {
        AttendanceState state = r.state();
        return new RosterActionResponse(state == null ? null : state.name(), r.going(), r.waitlist());
    }
}
