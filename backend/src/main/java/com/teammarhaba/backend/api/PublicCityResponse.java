package com.teammarhaba.backend.api;

import com.teammarhaba.backend.city.CityCatalogue;

/**
 * One catalogue city as exposed by the PUBLIC (any signed-in user) picker read
 * {@code GET /api/v1/cities/catalogue} (TM-1089). A LEAN projection of {@link CityCatalogue}: the
 * fields the profile/onboarding city picker (and, later, the Events-tab heading icon) need — name,
 * country, icon and geo. The admin/internal fields ({@code id}, {@code active}, timestamps,
 * soft-delete state, {@code version}) and the big empty-state {@code imagePath} are intentionally NOT
 * leaked here (the Home empty-state image consumption is a separate follow-up). Mirrors
 * {@code PublicInterestResponse}.
 *
 * @param name      display name of the city (e.g. "London")
 * @param country   the country (e.g. "United Kingdom")
 * @param iconEmoji default icon glyph (e.g. a flag), or {@code null} if none
 * @param geoLat    latitude in decimal degrees, or {@code null} if unset
 * @param geoLng    longitude in decimal degrees, or {@code null} if unset
 */
public record PublicCityResponse(String name, String country, String iconEmoji, Double geoLat, Double geoLng) {

    /** Project a {@link CityCatalogue} entity to the lean public picker shape. */
    public static PublicCityResponse from(CityCatalogue c) {
        return new PublicCityResponse(c.getName(), c.getCountry(), c.getIconEmoji(), c.getGeoLat(), c.getGeoLng());
    }
}
