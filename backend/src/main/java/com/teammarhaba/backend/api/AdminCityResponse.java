package com.teammarhaba.backend.api;

import com.teammarhaba.backend.city.CityCatalogue;
import java.time.Instant;

/**
 * A city as exposed by the admin cities API (TM-1089). A projection of {@link CityCatalogue}:
 * everything the admin console needs to list, edit and retire/restore cities, and none of the
 * internals ({@code version}). Deliberately surfaces the soft-delete state — both {@code deletedAt}
 * and a derived {@code retired} boolean — since showing whether a city is retired is the whole point
 * of the console (mirrors {@code AdminInterestResponse}).
 *
 * @param id         database id — the handle for the {@code /admin/cities/{id}} endpoints
 * @param name       display name
 * @param country    the country
 * @param iconEmoji  default icon glyph, or {@code null} if none
 * @param geoLat        latitude, or {@code null} if unset
 * @param geoLng        longitude, or {@code null} if unset
 * @param imagePath     big empty-state image storage path, or {@code null} if none
 * @param iconImagePath uploaded icon-image storage path (TM-1166), or {@code null} if none
 * @param sortWeight    ordering weight (higher sorts first)
 * @param active        whether the city is offered to users (retire sets false)
 * @param createdAt     DB-authoritative creation instant
 * @param updatedAt     last mutation instant
 * @param deletedAt     tombstone instant ({@code null} = not retired)
 * @param retired       {@code true} once retired (derived from {@code deletedAt})
 */
public record AdminCityResponse(
        Long id,
        String name,
        String country,
        String iconEmoji,
        Double geoLat,
        Double geoLng,
        String imagePath,
        String iconImagePath,
        int sortWeight,
        boolean active,
        Instant createdAt,
        Instant updatedAt,
        Instant deletedAt,
        boolean retired) {

    /** Project a {@link CityCatalogue} entity to the admin API shape. */
    public static AdminCityResponse from(CityCatalogue c) {
        return new AdminCityResponse(
                c.getId(),
                c.getName(),
                c.getCountry(),
                c.getIconEmoji(),
                c.getGeoLat(),
                c.getGeoLng(),
                c.getImagePath(),
                c.getIconImagePath(),
                c.getSortWeight(),
                c.isActive(),
                c.getCreatedAt(),
                c.getUpdatedAt(),
                c.getDeletedAt(),
                c.isDeleted());
    }
}
