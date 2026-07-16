package com.teammarhaba.backend.interests;

/**
 * Domain-side command for creating an interest (TM-774) — the {@code interests} package's own
 * value object, so the package stays free of the {@code api} request DTOs (mirrors {@code
 * VenueDraft}). Built by {@code CreateInterestRequest.toDraft()} after bean validation.
 *
 * @param label       display label, e.g. "Coffee &amp; cafés" (required, validated at the edge)
 * @param category    grouping bucket — one of {@link InterestCategories#KNOWN} (validated at the edge)
 * @param emoji       small glyph shown beside the label (TM-805), or {@code null} for none
 * @param highlighted whether the interest is featured
 * @param sortWeight  ordering weight, or {@code null} to let the service apply the default (100 when
 *                    highlighted, else 0 — the V45 seed convention)
 */
public record InterestDraft(
        String label, String category, String emoji, boolean highlighted, Integer sortWeight) {}
