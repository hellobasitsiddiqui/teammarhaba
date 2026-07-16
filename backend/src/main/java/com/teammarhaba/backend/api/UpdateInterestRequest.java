package com.teammarhaba.backend.api;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.teammarhaba.backend.interests.InterestCategories;
import com.teammarhaba.backend.interests.InterestPatch;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code PATCH /api/v1/admin/interests/{id}} (TM-774). Partial update in the house PATCH
 * convention: a {@code null}/omitted field is left unchanged. Per-field caps match
 * {@link CreateInterestRequest}.
 *
 * <p>{@code highlighted} is a nullable {@link Boolean} (NOT a primitive) — critical so "field not
 * sent" is distinguishable from "set to false"; a primitive would silently un-highlight an interest on
 * any partial edit that omits the flag. {@code label}, when present, must not be blank (the
 * {@code @AssertTrue} guard — present-but-blank is never meaningful, matching {@code
 * UpdateVenueRequest.isNameUsable()}). {@code category}, when present, must be a known bucket.
 *
 * @param label       new label (≤ 120), or {@code null} to leave unchanged (present-but-blank rejected)
 * @param category    new category (≤ 80, a known bucket), or {@code null} to leave unchanged
 * @param highlighted new highlight flag, or {@code null} to leave unchanged
 * @param sortWeight  new sort weight {@code [0, 1000]}, or {@code null} to leave unchanged
 */
public record UpdateInterestRequest(
        @Size(max = 120) String label,
        @Size(max = 80) String category,
        Boolean highlighted,
        @Min(0) @Max(1000) Integer sortWeight) {

    @JsonIgnore
    @AssertTrue(message = "label must not be blank")
    public boolean isLabelUsable() {
        return label == null || !label.isBlank();
    }

    @JsonIgnore
    @AssertTrue(message = "category must be one of the known interest categories")
    public boolean isCategoryKnown() {
        return category == null || InterestCategories.isKnown(category);
    }

    /** Map onto the domain-side command object ({@code interests} package stays free of api DTOs). */
    InterestPatch toPatch() {
        return new InterestPatch(label, category, highlighted, sortWeight);
    }
}
