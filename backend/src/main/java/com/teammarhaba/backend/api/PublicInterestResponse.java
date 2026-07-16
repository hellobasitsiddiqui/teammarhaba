package com.teammarhaba.backend.api;

import com.teammarhaba.backend.interests.InterestCatalogue;

/**
 * One catalogue interest as exposed by the PUBLIC (any signed-in user) picker read
 * {@code GET /api/v1/interests/catalogue} (TM-776, epic Interests). A deliberately LEAN projection of
 * {@link InterestCatalogue}: only the four fields the onboarding interests step (and the profile
 * Interests card) need to render the grouped, Popular-first picker.
 *
 * <p>Contrast with {@link AdminInterestResponse}, which surfaces the admin/internal fields
 * ({@code id}, {@code active}, {@code createdAt}/{@code updatedAt}, {@code deletedAt}, {@code retired}).
 * Those are intentionally OMITTED here — a fresh onboarding user must not see database ids or the
 * soft-delete lifecycle. The controller only ever returns CURRENTLY OFFERED rows (active + not
 * tombstoned), so an {@code active} flag would be redundant, and {@code sortWeight} is included purely
 * so the client can re-derive the same "highlights float to the top" order the server sends.
 *
 * @param label       display label of the interest (e.g. "Coffee &amp; cafés")
 * @param category    the grouping bucket (e.g. "Food &amp; Drink"), one of {@code InterestCategories.KNOWN}
 * @param emoji       small glyph shown beside the label (e.g. "☕"), or {@code null} if none (TM-804)
 * @param highlighted whether the interest is featured (drives the synthetic "Popular" group client-side)
 * @param sortWeight  ordering weight — higher sorts first (highlighted seed rows carry 100, others 0)
 */
public record PublicInterestResponse(
        String label, String category, String emoji, boolean highlighted, int sortWeight) {

    /** Project an {@link InterestCatalogue} entity to the lean public picker shape. */
    public static PublicInterestResponse from(InterestCatalogue c) {
        return new PublicInterestResponse(
                c.getLabel(), c.getCategory(), c.getEmoji(), c.isHighlighted(), c.getSortWeight());
    }
}
