package com.teammarhaba.backend.event;

/**
 * Outcome of an attendance command — RSVP or claim (TM-393). Tells the caller where they landed
 * ({@code GOING}, or {@code WAITLISTED} when the event was full) plus the fresh counts, so the
 * client can update its badges without a follow-up read. Counts are taken inside the command's
 * locked transaction, so they are exact at the moment the change committed.
 *
 * @param state           where the caller ended up ({@code GOING} or {@code WAITLISTED})
 * @param goingCount      attendees holding a GOING spot, after this change
 * @param waitlistedCount attendees queued on the waitlist, after this change
 */
public record RsvpResult(AttendanceState state, long goingCount, long waitlistedCount) {}
