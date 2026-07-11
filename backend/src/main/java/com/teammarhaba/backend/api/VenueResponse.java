package com.teammarhaba.backend.api;

import com.teammarhaba.backend.event.IndoorOutdoor;
import com.teammarhaba.backend.event.Venue;
import java.time.Instant;

/**
 * A venue as exposed by the admin venues API (TM-519). A projection of {@link Venue}: everything the
 * admin console needs to list, edit and deactivate venues, and the event-create picker needs to offer
 * them — and none of the internals ({@code version}, {@code deletedAt}).
 *
 * <p>This admin/authenticated projection carries the exact {@code addressLine}; the public event
 * surface never exposes a referenced venue's address (it renders the reveal-gated
 * {@code events.location_text}), so surfacing the full address here does not undermine the TM-408
 * location-reveal policy.
 *
 * @param id            database id — the handle for the {@code /admin/venues/{id}} endpoints
 * @param name          display name of the place
 * @param addressLine   full street address
 * @param city          coarse locality / area tag ({@code null} = none)
 * @param latitude      latitude in decimal degrees ({@code null} = no pin)
 * @param longitude     longitude in decimal degrees ({@code null} = no pin)
 * @param mapUrl        map-pin link ({@code null} = none)
 * @param notes         description / directions ({@code null} = none)
 * @param capacity      headline capacity ({@code null} = unspecified)
 * @param accessibility accessibility notes ({@code null} = none)
 * @param parking       parking notes ({@code null} = none)
 * @param indoorOutdoor {@code INDOOR | OUTDOOR | MIXED} ({@code null} = unspecified)
 * @param photoPath     storage path of the venue photo ({@code null} = no photo)
 * @param active        whether the venue is offered in the event-create picker (deactivate sets false)
 * @param createdBy     {@code users.id} of the creating admin
 * @param createdAt     DB-authoritative creation instant
 * @param updatedAt     last mutation instant
 */
public record VenueResponse(
        Long id,
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
        String photoPath,
        boolean active,
        Long createdBy,
        Instant createdAt,
        Instant updatedAt) {

    /** Project a {@link Venue} entity to the admin API shape. */
    public static VenueResponse from(Venue venue) {
        return new VenueResponse(
                venue.getId(),
                venue.getName(),
                venue.getAddressLine(),
                venue.getCity(),
                venue.getLatitude(),
                venue.getLongitude(),
                venue.getMapUrl(),
                venue.getNotes(),
                venue.getCapacity(),
                venue.getAccessibility(),
                venue.getParking(),
                venue.getIndoorOutdoor(),
                venue.getPhotoPath(),
                venue.isActive(),
                venue.getCreatedBy(),
                venue.getCreatedAt(),
                venue.getUpdatedAt());
    }
}
