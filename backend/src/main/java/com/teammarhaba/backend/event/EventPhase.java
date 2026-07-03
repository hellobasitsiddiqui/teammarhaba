package com.teammarhaba.backend.event;

/**
 * The <em>temporal</em> phase of an {@link Event} relative to "now" (TM-412) — where the event sits
 * on the clock, derived on the fly from {@code startAt}/{@code endAt} and never persisted.
 *
 * <p><b>Distinct from {@link EventStatus}.</b> {@code EventStatus} is the admin-driven lifecycle
 * (PUBLISHED / CANCELLED); {@code EventPhase} is a pure function of time computed by
 * {@link EventPhasePolicy}. A single event is, say, {@code PUBLISHED} <em>and</em>
 * {@code HAPPENING_NOW}. The public read side surfaces the phase on each card/detail so the client
 * can badge live events and group them.
 *
 * <p><b>Boundaries</b> (inclusive of both endpoints of the live window, matching the AC
 * "{@code start_at ≤ now ≤ end_at}"):
 *
 * <ul>
 *   <li>{@link #UPCOMING} — {@code now < startAt} (not started yet).</li>
 *   <li>{@link #HAPPENING_NOW} — {@code startAt ≤ now ≤ effectiveEnd} (live). {@code effectiveEnd}
 *       is {@code endAt}, or {@code startAt + defaultDuration} when the event is open-ended
 *       ({@code endAt} is null).</li>
 *   <li>{@link #FINISHED} — {@code now > effectiveEnd} (ended). The public listing excludes these
 *       and the detail endpoint 404s them, so a client only ever observes the first two phases.</li>
 * </ul>
 */
public enum EventPhase {

    /** Not started yet ({@code now < startAt}); listed soonest-first as today. */
    UPCOMING,

    /** Live right now ({@code startAt ≤ now ≤ effectiveEnd}); surfaced to the top of the listing. */
    HAPPENING_NOW,

    /** Ended ({@code now > effectiveEnd}); dropped from the listing and 404'd on detail. */
    FINISHED
}
