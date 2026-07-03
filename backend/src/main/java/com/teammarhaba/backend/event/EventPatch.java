package com.teammarhaba.backend.event;

import java.time.Instant;

/**
 * Command object for a partial event edit through the admin API (TM-392) — the domain-side shape
 * {@code UpdateEventRequest} maps onto. Follows the house PATCH convention ({@code
 * UpdateUserRequest}, TM-111): a {@code null} field means <em>leave unchanged</em>, so clearing an
 * optional field back to {@code null} is not expressible through this API yet (documented
 * trade-off; a tri-state wrapper can be added if the admin console ever needs it).
 */
public record EventPatch(
        String heading,
        String description,
        String locationText,
        String mapUrl,
        String onlineUrl,
        String city,
        String timezone,
        Instant startAt,
        Instant endAt,
        Instant visibilityStart,
        Instant visibilityEnd,
        Integer capacity,
        String imagePath,
        Integer locationRevealHours) {

    /** {@code true} if the patch carries no fields at all (a guaranteed no-op). */
    public boolean isEmpty() {
        return heading == null
                && description == null
                && locationText == null
                && mapUrl == null
                && onlineUrl == null
                && city == null
                && timezone == null
                && startAt == null
                && endAt == null
                && visibilityStart == null
                && visibilityEnd == null
                && capacity == null
                && imagePath == null
                && locationRevealHours == null;
    }
}
