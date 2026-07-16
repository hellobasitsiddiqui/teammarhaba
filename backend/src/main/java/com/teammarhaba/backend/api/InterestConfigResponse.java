package com.teammarhaba.backend.api;

import com.teammarhaba.backend.interests.InterestAdminService.InterestConfig;

/**
 * The interests min/max-selection bounds as exposed by {@code GET}/{@code PUT
 * /api/v1/admin/interests/config} (TM-774) — the persisted values, read back after a write.
 *
 * @param minSelections minimum interests a user must select
 * @param maxSelections maximum interests a user may select
 */
public record InterestConfigResponse(int minSelections, int maxSelections) {

    /** Project the service-side config value object to the admin API shape. */
    public static InterestConfigResponse from(InterestConfig config) {
        return new InterestConfigResponse(config.minSelections(), config.maxSelections());
    }
}
