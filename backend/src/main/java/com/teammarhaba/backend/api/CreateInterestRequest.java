package com.teammarhaba.backend.api;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.teammarhaba.backend.interests.InterestCategories;
import com.teammarhaba.backend.interests.InterestDraft;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code POST /api/v1/admin/interests} (TM-774). Field caps mirror the
 * {@code interest_catalogue} columns (V45: {@code label VARCHAR(120)}, {@code category VARCHAR(80)}).
 *
 * <p>{@code highlighted} is a primitive — an absent value is {@code false}, matching the column
 * {@code DEFAULT false}. {@code sortWeight} is a nullable {@link Integer}: omit it and the service
 * applies the seed convention (100 when highlighted, else 0); its bounds {@code [0, 1000]} are a sane
 * documented range (there is no schema cap beyond {@code int}). Label uniqueness among ACTIVE rows is
 * NOT a bean-validation rule (it needs a DB read) — it is enforced in the service and surfaces as 409.
 *
 * @param label       display label, e.g. "Coffee &amp; cafés" (required, ≤ 120)
 * @param category    grouping bucket — must be one of {@link InterestCategories#KNOWN} (required, ≤ 80)
 * @param highlighted whether the interest is featured (absent → false)
 * @param sortWeight  ordering weight {@code [0, 1000]}, or omit for the highlighted-aware default
 */
public record CreateInterestRequest(
        @NotBlank @Size(max = 120) String label,
        @NotBlank @Size(max = 80) String category,
        boolean highlighted,
        @Min(0) @Max(1000) Integer sortWeight) {

    /** Category must be one of the seven known buckets ({@code null} is left to {@code @NotBlank}). */
    @JsonIgnore
    @AssertTrue(message = "category must be one of the known interest categories")
    public boolean isCategoryKnown() {
        return category == null || InterestCategories.isKnown(category);
    }

    /** Map onto the domain-side command object ({@code interests} package stays free of api DTOs). */
    InterestDraft toDraft() {
        return new InterestDraft(label, category, highlighted, sortWeight);
    }
}
