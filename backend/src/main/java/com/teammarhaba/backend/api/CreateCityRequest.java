package com.teammarhaba.backend.api;

import com.teammarhaba.backend.city.CityDraft;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code POST /api/v1/admin/cities} (TM-1089). Field caps mirror the {@code city_catalogue}
 * columns (V54: {@code name VARCHAR(120)}, {@code country VARCHAR(80)}, {@code image_path VARCHAR(500)}).
 *
 * <p>{@code sortWeight} is a nullable {@link Integer}: omit it and the service applies the default (0);
 * its bounds {@code [0, 1000]} are a sane documented range. Name uniqueness among ACTIVE rows is NOT a
 * bean-validation rule (it needs a DB read) — it is enforced in the service and surfaces as 409. Geo is
 * validated to real WGS-84 ranges when present.
 *
 * @param name       display name, e.g. "London" (required, ≤ 120)
 * @param country    the country, e.g. "United Kingdom" (required, ≤ 80)
 * @param iconEmoji  default icon glyph (≤ 16 chars — a generous cap covering flag/ZWJ sequences), or omit
 * @param geoLat        latitude in decimal degrees {@code [-90, 90]}, or omit
 * @param geoLng        longitude in decimal degrees {@code [-180, 180]}, or omit
 * @param imagePath     storage path of the big empty-state image (≤ 500), or omit
 * @param iconImagePath storage path of the uploaded icon image (≤ 500, TM-1166), or omit
 * @param sortWeight    ordering weight {@code [0, 1000]}, or omit for the default (0)
 */
public record CreateCityRequest(
        @NotBlank @Size(max = 120) String name,
        @NotBlank @Size(max = 80) String country,
        @Size(max = 16) String iconEmoji,
        @DecimalMin("-90.0") @DecimalMax("90.0") Double geoLat,
        @DecimalMin("-180.0") @DecimalMax("180.0") Double geoLng,
        @Size(max = 500) String imagePath,
        @Size(max = 500) String iconImagePath,
        @Min(0) @Max(1000) Integer sortWeight) {

    /** Map onto the domain-side command object ({@code city} package stays free of api DTOs). */
    CityDraft toDraft() {
        return new CityDraft(name, country, iconEmoji, geoLat, geoLng, imagePath, iconImagePath, sortWeight);
    }
}
