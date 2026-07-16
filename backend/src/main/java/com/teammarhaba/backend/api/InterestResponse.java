package com.teammarhaba.backend.api;

import com.teammarhaba.backend.interests.UserInterest;

/**
 * One interest the user has saved (TM-775), exposed on {@code GET}/{@code PATCH /api/v1/me}. A
 * read-only free-text snapshot: {@code label} and {@code category} are the values frozen at pick time
 * (independent of any later catalogue edit/retire — the TM-773 snapshot invariant), plus the optional
 * provenance pointer to the source catalogue row.
 *
 * @param label            the user's saved interest label (free-text copy, frozen at pick time)
 * @param category         the category it was grouped under (free-text copy, frozen at pick time)
 * @param sourceInterestId provenance hint to the source catalogue id, or {@code null} if none
 */
public record InterestResponse(String label, String category, Long sourceInterestId) {

    /** Map a saved snapshot onto its response shape (house {@code EventResponse.from} convention). */
    static InterestResponse from(UserInterest ui) {
        return new InterestResponse(ui.getLabel(), ui.getCategory(), ui.getSourceInterestId());
    }
}
