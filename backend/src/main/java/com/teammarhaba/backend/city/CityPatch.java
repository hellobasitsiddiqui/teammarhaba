package com.teammarhaba.backend.city;

/**
 * Domain-side command for a partial edit of a city (TM-1089) — the {@code city} package's own value
 * object (mirrors {@code InterestPatch}). Built by {@code UpdateCityRequest.toPatch()}. House PATCH
 * convention: a {@code null} field is left unchanged.
 *
 * <p>Because {@code null} means "leave unchanged", a partial edit cannot re-null a field that already
 * holds a value (e.g. clear a geo point back to unset). This is consistent with how the other optional
 * fields behave (cf. {@code InterestPatch.emoji}) and adequate for the admin console — a field can be
 * given/changed, and an emoji/image can be blanked by sending {@code ""} (normalised to {@code null}).
 *
 * @param name       new name, or {@code null} to leave unchanged
 * @param country    new country, or {@code null} to leave unchanged
 * @param iconEmoji  new icon glyph ({@code ""} clears it), or {@code null} to leave unchanged
 * @param geoLat     new latitude, or {@code null} to leave unchanged
 * @param geoLng     new longitude, or {@code null} to leave unchanged
 * @param imagePath  new image path ({@code ""} clears it), or {@code null} to leave unchanged
 * @param sortWeight new sort weight, or {@code null} to leave unchanged
 */
public record CityPatch(
        String name,
        String country,
        String iconEmoji,
        Double geoLat,
        Double geoLng,
        String imagePath,
        Integer sortWeight) {

    /** {@code true} when the patch carries no field at all — a no-op edit (no touch, no audit). */
    public boolean isEmpty() {
        return name == null
                && country == null
                && iconEmoji == null
                && geoLat == null
                && geoLng == null
                && imagePath == null
                && sortWeight == null;
    }
}
