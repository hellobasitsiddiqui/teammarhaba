package com.teammarhaba.backend.city;

/**
 * Domain-side command for creating a city (TM-1089) — the {@code city} package's own value object,
 * so the package stays free of the {@code api} request DTOs (mirrors {@code InterestDraft}). Built by
 * {@code CreateCityRequest.toDraft()} after bean validation.
 *
 * @param name       display name, e.g. "London" (required, validated at the edge)
 * @param country    the country, e.g. "United Kingdom" (required, validated at the edge)
 * @param iconEmoji  default icon glyph, or {@code null} for none
 * @param geoLat        latitude in decimal degrees, or {@code null} if unset
 * @param geoLng        longitude in decimal degrees, or {@code null} if unset
 * @param imagePath     storage path of the big empty-state image, or {@code null} for none
 * @param iconImagePath storage path of the uploaded icon image (TM-1166), or {@code null} for none
 * @param sortWeight    ordering weight, or {@code null} to let the service apply the default (0)
 */
public record CityDraft(
        String name,
        String country,
        String iconEmoji,
        Double geoLat,
        Double geoLng,
        String imagePath,
        String iconImagePath,
        Integer sortWeight) {}
