package com.teammarhaba.backend.api;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.teammarhaba.backend.city.CityPatch;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code PATCH /api/v1/admin/cities/{id}} (TM-1089). Partial update in the house PATCH
 * convention: a {@code null}/omitted field is left unchanged. Per-field caps match
 * {@link CreateCityRequest}.
 *
 * <p>{@code name}/{@code country}, when present, must not be blank (the {@code @AssertTrue} guards —
 * present-but-blank is never meaningful, matching {@code UpdateInterestRequest.isLabelUsable()}). Geo,
 * when present, must be in real WGS-84 ranges.
 *
 * @param name       new name (≤ 120), or {@code null} to leave unchanged (present-but-blank rejected)
 * @param country    new country (≤ 80), or {@code null} to leave unchanged (present-but-blank rejected)
 * @param iconEmoji  new icon glyph (≤ 16; {@code ""} clears it), or {@code null} to leave unchanged
 * @param geoLat     new latitude {@code [-90, 90]}, or {@code null} to leave unchanged
 * @param geoLng     new longitude {@code [-180, 180]}, or {@code null} to leave unchanged
 * @param imagePath  new image path (≤ 500; {@code ""} clears it), or {@code null} to leave unchanged
 * @param sortWeight new sort weight {@code [0, 1000]}, or {@code null} to leave unchanged
 */
public record UpdateCityRequest(
        @Size(max = 120) String name,
        @Size(max = 80) String country,
        @Size(max = 16) String iconEmoji,
        @DecimalMin("-90.0") @DecimalMax("90.0") Double geoLat,
        @DecimalMin("-180.0") @DecimalMax("180.0") Double geoLng,
        @Size(max = 500) String imagePath,
        @Min(0) @Max(1000) Integer sortWeight) {

    @JsonIgnore
    @AssertTrue(message = "name must not be blank")
    public boolean isNameUsable() {
        return name == null || !name.isBlank();
    }

    @JsonIgnore
    @AssertTrue(message = "country must not be blank")
    public boolean isCountryUsable() {
        return country == null || !country.isBlank();
    }

    /** Map onto the domain-side command object ({@code city} package stays free of api DTOs). */
    CityPatch toPatch() {
        return new CityPatch(name, country, iconEmoji, geoLat, geoLng, imagePath, sortWeight);
    }
}
