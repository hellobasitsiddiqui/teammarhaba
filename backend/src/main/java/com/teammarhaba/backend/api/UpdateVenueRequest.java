package com.teammarhaba.backend.api;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.teammarhaba.backend.event.IndoorOutdoor;
import com.teammarhaba.backend.event.VenuePatch;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code PATCH /api/v1/admin/venues/{id}} (TM-519). Partial update in the house PATCH
 * convention (TM-111's {@code UpdateUserRequest}): a {@code null}/omitted field is left unchanged.
 * Consequence (documented trade-off): an optional field cannot be cleared back to {@code null}
 * through this API yet.
 *
 * <p>Per-field caps match {@link CreateVenueRequest}; the required-on-create fields ({@code name},
 * {@code addressLine}) additionally reject a <em>blank</em> value here (present-but-empty is never
 * meaningful). The coordinate-pair rule ("both or neither") is enforced only when the patch carries
 * both edges — patching a single edge against the persisted other side is allowed, since the entity
 * may already hold its partner.
 */
public record UpdateVenueRequest(
        @Size(max = 160) String name,
        @Size(max = 500) String addressLine,
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

    @JsonIgnore
    @AssertTrue(message = "name must not be blank")
    public boolean isNameUsable() {
        return name == null || !name.isBlank();
    }

    @JsonIgnore
    @AssertTrue(message = "addressLine must not be blank")
    public boolean isAddressLineUsable() {
        return addressLine == null || !addressLine.isBlank();
    }

    /** Map onto the domain-side command object ({@code event} package stays free of api DTOs). */
    VenuePatch toPatch() {
        return new VenuePatch(
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
