package com.teammarhaba.backend.event;

/**
 * Command object for a partial {@link Venue} edit through the admin API (TM-519) — the domain-side
 * shape {@code UpdateVenueRequest} maps onto. Follows the house PATCH convention ({@link EventPatch},
 * TM-111): a {@code null} field means <em>leave unchanged</em>, so clearing an optional field back to
 * {@code null} is not expressible through this API yet (documented trade-off; a tri-state wrapper can
 * be added if the console ever needs it). The {@code active} flag is deliberately <em>not</em> here —
 * deactivate/reactivate are their own explicit sub-actions, exactly as event cancel is not a PATCH.
 */
public record VenuePatch(
        String name,
        String addressLine,
        String city,
        Double latitude,
        Double longitude,
        String mapUrl,
        String notes,
        Integer capacity,
        String accessibility,
        String parking,
        IndoorOutdoor indoorOutdoor,
        String photoPath) {

    /** {@code true} if the patch carries no fields at all (a guaranteed no-op). */
    public boolean isEmpty() {
        return name == null
                && addressLine == null
                && city == null
                && latitude == null
                && longitude == null
                && mapUrl == null
                && notes == null
                && capacity == null
                && accessibility == null
                && parking == null
                && indoorOutdoor == null
                && photoPath == null;
    }
}
