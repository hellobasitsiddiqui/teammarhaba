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
 * <p><b>{@code selectionCount} (TM-1094).</b> How many CURRENT users have this interest saved — the real
 * selection popularity behind each catalogue row. It lets the client order the non-featured tail of each
 * category by actual popularity (most-picked first) instead of alphabetically, while the featured/
 * {@code highlighted} "Popular" group stays pinned first (TM-1095). It reflects the same active-user
 * population the admin "Selected by" analytics count (TM-832) — a label no active user has selected
 * carries {@code 0}, never {@code null}, so the client's sort is total. The count is computed with ONE
 * batched {@code COUNT(*) GROUP BY label} over {@code user_interest} (never an N+1) and joined onto the
 * catalogue rows by label in {@code InterestCatalogueController}.
 *
 * @param label          display label of the interest (e.g. "Coffee &amp; cafés")
 * @param category       the grouping bucket (e.g. "Food &amp; Drink"), one of {@code InterestCategories.KNOWN}
 * @param emoji          small glyph shown beside the label (e.g. "☕"), or {@code null} if none (TM-804)
 * @param highlighted    whether the interest is featured (drives the synthetic "Popular" group client-side)
 * @param sortWeight     ordering weight — higher sorts first (highlighted seed rows carry 100, others 0)
 * @param selectionCount how many current users have this interest saved — real popularity, 0 if nobody (TM-1094)
 */
public record PublicInterestResponse(
        String label, String category, String emoji, boolean highlighted, int sortWeight, int selectionCount) {

    /**
     * Project an {@link InterestCatalogue} entity to the lean public picker shape, joining on this row's
     * real selection count. Callers that do not (yet) have counts to hand — or a row nobody has selected
     * — pass {@code 0} via {@link #from(InterestCatalogue)}.
     */
    public static PublicInterestResponse from(InterestCatalogue c, int selectionCount) {
        return new PublicInterestResponse(
                c.getLabel(),
                c.getCategory(),
                c.getEmoji(),
                c.isHighlighted(),
                c.getSortWeight(),
                selectionCount);
    }

    /** Project an {@link InterestCatalogue} with a {@code 0} selection count (nobody has picked it yet). */
    public static PublicInterestResponse from(InterestCatalogue c) {
        return from(c, 0);
    }
}
