package com.teammarhaba.backend.event;

/**
 * The outcome of an admin capacity adjustment (TM-592) — the value the roster console renders after an
 * increase/decrease. All spot maths are derived under the event {@code SELECT … FOR UPDATE} lock, so
 * the counts are the committed truth at the moment of the edit.
 *
 * <p><b>Over-capacity (owner decision).</b> Lowering capacity below the current {@code going} count is
 * <em>allowed</em>: no confirmed attendee is ever auto-evicted, so the event simply sits over-cap until
 * attendance drops back under the new limit (new RSVPs waitlist; no new GOING joins meanwhile). This
 * record surfaces that state to the admin: {@code overCapacityBy} is how many committed attendees sit
 * over the new cap ({@code max(0, going − capacity)}) and drives the warning banner; {@code freeSpots}
 * is the derived open-spot count, <b>clamped at ≥ 0</b> so it is never negative even while over-cap.
 *
 * @param capacity       the event's capacity AFTER the adjustment ({@code null} = unlimited)
 * @param going          the current committed ({@code GOING}) attendee count, unchanged by the edit
 * @param waitlist       the current {@code WAITLISTED} count
 * @param freeSpots      derived open spots, {@code max(0, capacity − going)} — {@code null} when unlimited
 * @param overCapacityBy how many committed attendees sit over the new cap, {@code max(0, going − capacity)};
 *                       0 when at/under cap or unlimited. A positive value is the warning trigger.
 */
public record CapacityAdjustResult(
        Integer capacity, long going, long waitlist, Integer freeSpots, long overCapacityBy) {

    /**
     * Derive the result from the post-edit capacity and the live counts, clamping every derived figure at
     * {@code ≥ 0}. An {@code unlimited} event (null capacity) has no free-spot ceiling and can never be
     * over capacity.
     */
    public static CapacityAdjustResult of(Integer capacity, long going, long waitlist) {
        if (capacity == null) {
            return new CapacityAdjustResult(null, going, waitlist, null, 0);
        }
        int free = (int) Math.max(0, capacity - going); // clamp ≥ 0: never negative even while over-cap
        long over = Math.max(0, going - capacity);
        return new CapacityAdjustResult(capacity, going, waitlist, free, over);
    }

    /** {@code true} when committed attendance sits over the new cap — the admin's warning trigger. */
    public boolean isOverCapacity() {
        return overCapacityBy > 0;
    }
}
