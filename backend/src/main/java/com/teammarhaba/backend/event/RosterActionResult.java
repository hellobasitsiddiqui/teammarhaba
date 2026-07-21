package com.teammarhaba.backend.event;

/**
 * The outcome of an admin roster action — an evict or a force-add (TM-592). Carries the target's
 * resulting attendance state and the event's live counts, all read under the event
 * {@code SELECT … FOR UPDATE} lock so they are the committed truth at the moment of the action.
 *
 * @param state    the target's attendance state after the action: {@code GOING} after a force-add,
 *                 {@code null} after an evict (they now hold no attendance)
 * @param going    the event's committed ({@code GOING}) count after the action
 * @param waitlist the event's {@code WAITLISTED} count after the action
 */
public record RosterActionResult(AttendanceState state, long going, long waitlist) {}
