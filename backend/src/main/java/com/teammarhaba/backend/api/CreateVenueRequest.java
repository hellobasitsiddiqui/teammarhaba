package com.teammarhaba.backend.api;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.teammarhaba.backend.event.IndoorOutdoor;
import com.teammarhaba.backend.event.VenueDraft;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code POST /api/v1/admin/venues} (TM-519). Field caps mirror the {@code venues} columns
 * (V40); only {@code name} and {@code addressLine} are required. Latitude/longitude, when given, must
 * be a valid coordinate pair (both present, in range) — an {@code @AssertTrue} property so the
 * violation surfaces through the standard RFC-7807 validation body.
 *
 * <p>{@code photoPath} is the Firebase Storage object path of an already-uploaded venue photo (the
 * house avatar/image pattern, TM-166: the console uploads {@code venue-images/{venueId}} directly to
 * Storage — admin-only per {@code storage.rules} — and the backend persists only the path). It is
 * normally set by a follow-up PATCH, because the id doesn't exist before creation.
 *
 * @param name          display name of the place (≤ 160)
 * @param addressLine   full street address on one line (≤ 500)
 * @param city          optional coarse locality / area tag (≤ 120)
 * @param latitude      optional latitude in decimal degrees ({@code -90..90}); pair with longitude
 * @param longitude     optional longitude in decimal degrees ({@code -180..180}); pair with latitude
 * @param mapUrl        optional map-pin link (≤ 2048)
 * @param notes         optional description / directions (≤ 5000)
 * @param capacity      optional headline capacity, ≥ 1; omitted = unspecified
 * @param accessibility optional accessibility notes (≤ 1000)
 * @param parking       optional parking notes (≤ 1000)
 * @param indoorOutdoor optional {@code INDOOR | OUTDOOR | MIXED}; omitted = unspecified
 * @param photoPath     optional storage path of the venue photo ({@code venue-images/…})
 */
public record CreateVenueRequest(
        @NotBlank @Size(max = 160) String name,
        @NotBlank @Size(max = 500) String addressLine,
        @Size(max = 120) String city,
        @DecimalMin("-90.0") @DecimalMax("90.0") Double latitude,
        @DecimalMin("-180.0") @DecimalMax("180.0") Double longitude,
        @Size(max = 2048) String mapUrl,
        @Size(max = 5000) String notes,
        @Min(1) Integer capacity,
        @Size(max = 1000) String accessibility,
        @Size(max = 1000) String parking,
        IndoorOutdoor indoorOutdoor,
        @Size(max = 512)
                @Pattern(
                        regexp = "venue-images/[A-Za-z0-9._-]+",
                        message = "must be a storage object path like venue-images/{venueId}")
                String photoPath) {

    /** A geo pin needs both edges — half a coordinate can't place a point on a map. */
    @JsonIgnore
    @AssertTrue(message = "latitude and longitude must be provided together")
    public boolean isCoordinatePairComplete() {
        return (latitude == null) == (longitude == null);
    }

    /** Map onto the domain-side command object ({@code event} package stays free of api DTOs). */
    VenueDraft toDraft() {
        return new VenueDraft(
                name,
                addressLine,
                city,
                latitude,
                longitude,
                mapUrl,
                notes,
                capacity,
                accessibility,
                parking,
                indoorOutdoor,
                photoPath);
    }
}
