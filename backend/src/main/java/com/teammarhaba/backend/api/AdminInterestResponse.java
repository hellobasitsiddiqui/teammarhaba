package com.teammarhaba.backend.api;

import com.teammarhaba.backend.interests.InterestCatalogue;
import java.time.Instant;

/**
 * An interest as exposed by the admin interests API (TM-774). A projection of
 * {@link InterestCatalogue}: everything the admin console needs to list, edit and retire/restore
 * interests, and none of the internals ({@code version}, per the {@code VenueResponse} precedent).
 *
 * <p>This admin projection deliberately surfaces the soft-delete state — both {@code deletedAt} (the
 * tombstone instant) and a derived {@code retired} boolean ({@link InterestCatalogue#isDeleted()}).
 * The admin list is the ONE place that state is legitimately visible (everywhere else the entity's
 * {@code @SQLRestriction} hides it); showing whether an interest is retired is the whole point of the
 * console, not an internal leak.
 *
 * @param id         database id — the handle for the {@code /admin/interests/{id}} endpoints
 * @param label      display label
 * @param category   grouping bucket
 * @param highlighted whether the interest is featured
 * @param sortWeight ordering weight (higher sorts first)
 * @param active     whether the interest is offered to users (retire sets false)
 * @param createdAt  DB-authoritative creation instant
 * @param updatedAt  last mutation instant
 * @param deletedAt  tombstone instant ({@code null} = not retired)
 * @param retired    {@code true} once retired (derived from {@code deletedAt})
 */
public record AdminInterestResponse(
        Long id,
        String label,
        String category,
        boolean highlighted,
        int sortWeight,
        boolean active,
        Instant createdAt,
        Instant updatedAt,
        Instant deletedAt,
        boolean retired) {

    /** Project an {@link InterestCatalogue} entity to the admin API shape. */
    public static AdminInterestResponse from(InterestCatalogue c) {
        return new AdminInterestResponse(
                c.getId(),
                c.getLabel(),
                c.getCategory(),
                c.isHighlighted(),
                c.getSortWeight(),
                c.isActive(),
                c.getCreatedAt(),
                c.getUpdatedAt(),
                c.getDeletedAt(),
                c.isDeleted());
    }
}
