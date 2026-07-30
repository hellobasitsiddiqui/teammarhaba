package com.teammarhaba.backend.api;

import com.teammarhaba.backend.city.CityCatalogue;

/**
 * One catalogue city as exposed by the PUBLIC (any signed-in user) picker read
 * {@code GET /api/v1/cities/catalogue} (TM-1089). A LEAN projection of {@link CityCatalogue}: the
 * fields the profile/onboarding city picker (and, later, the Events-tab heading icon) need — name,
 * country, both icon forms and geo. The admin/internal fields ({@code id}, {@code active}, timestamps,
 * soft-delete state, {@code version}) and the big empty-state {@code imagePath} are intentionally NOT
 * leaked here (the Home empty-state image consumption is a separate follow-up). Mirrors
 * {@code PublicInterestResponse}.
 *
 * <p>Both icon FORMS ride the public shape: {@code iconEmoji} (the fallback glyph) AND
 * {@code iconImagePath} (the uploaded icon image, TM-1166) — the icon beside a city name is a
 * non-secret display asset (exactly like the emoji), so the picker resolves an uploaded image when
 * present and falls back to the emoji otherwise. The big empty-state {@code imagePath} stays
 * admin-only, being a different, still-deferred consumption (the Home empty state).
 *
 * @param name          display name of the city (e.g. "London")
 * @param country       the country (e.g. "United Kingdom")
 * @param iconEmoji     default icon glyph (e.g. a flag), or {@code null} if none
 * @param iconImagePath uploaded icon-image storage path (TM-1166), or {@code null} if none
 * @param geoLat        latitude in decimal degrees, or {@code null} if unset
 * @param geoLng        longitude in decimal degrees, or {@code null} if unset
 */
public record PublicCityResponse(
        String name, String country, String iconEmoji, String iconImagePath, Double geoLat, Double geoLng) {

    /** Project a {@link CityCatalogue} entity to the lean public picker shape. */
    public static PublicCityResponse from(CityCatalogue c) {
        return new PublicCityResponse(
                c.getName(), c.getCountry(), c.getIconEmoji(), c.getIconImagePath(), c.getGeoLat(), c.getGeoLng());
    }
}
