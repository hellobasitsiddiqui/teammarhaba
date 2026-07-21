package com.teammarhaba.backend.api;

import com.teammarhaba.backend.event.CapacityAdjustResult;

/**
 * The result of an admin capacity adjustment (TM-592) — returned by
 * {@code POST /api/v1/admin/events/{id}/capacity}. Carries the new capacity, the live counts and — the
 * point of this endpoint — the over-capacity warning the console shows when the cap was lowered below the
 * current GOING count.
 *
 * @param capacity       the event's capacity after the adjustment ({@code null} = unlimited)
 * @param going          the committed ({@code GOING}) count (unchanged by a capacity edit)
 * @param waitlist       the {@code WAITLISTED} count
 * @param freeSpots      derived open spots, clamped {@code ≥ 0} ({@code null} when unlimited)
 * @param overCapacityBy how many committed attendees sit over the new cap (0 when at/under cap)
 * @param overCapacity   convenience flag: {@code overCapacityBy > 0} — the warning trigger
 */
public record CapacityAdjustResponse(
        Integer capacity, long going, long waitlist, Integer freeSpots, long overCapacityBy, boolean overCapacity) {

    public static CapacityAdjustResponse from(CapacityAdjustResult r) {
        return new CapacityAdjustResponse(
                r.capacity(), r.going(), r.waitlist(), r.freeSpots(), r.overCapacityBy(), r.isOverCapacity());
    }
}
