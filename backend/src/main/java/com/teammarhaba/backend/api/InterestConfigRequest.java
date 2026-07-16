package com.teammarhaba.backend.api;

import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;

/**
 * Body for {@code PUT /api/v1/admin/interests/config} (TM-774) — sets both interests-selection bounds
 * in one call. PUT (full replacement) not PATCH: both values are always sent together, and the
 * cross-field {@code max >= min} rule is only checkable with both present. Both are required
 * ({@code @NotNull}) and each must be {@code >= 1} ({@code @Min(1)}, the spec's {@code min >= 1});
 * {@code @AssertTrue} enforces {@code max >= min}.
 *
 * @param minSelections minimum interests a user must select (required, ≥ 1)
 * @param maxSelections maximum interests a user may select (required, ≥ 1, ≥ minSelections)
 */
public record InterestConfigRequest(
        @NotNull @Min(1) Integer minSelections, @NotNull @Min(1) Integer maxSelections) {

    @JsonIgnore
    @AssertTrue(message = "maxSelections must be greater than or equal to minSelections")
    public boolean isRangeOrdered() {
        return minSelections == null || maxSelections == null || maxSelections >= minSelections;
    }
}
