package com.teammarhaba.backend.appconfig;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.interests.InterestSelectionConfig;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Verifies the runtime config store against a real Postgres (Testcontainers): the {@code V45} seed rows
 * for the interests min/max-selection bounds are present, the typed {@link InterestSelectionConfig}
 * reads them as 1 / 3 from the DB (not a compile-time constant), and {@link AppConfigService}'s
 * fail-safe default path returns the fallback for an absent key. Fail-before/pass-after.
 */
class AppConfigServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private InterestSelectionConfig selectionConfig;

    @Autowired
    private AppConfigService appConfigService;

    @Autowired
    private JdbcTemplate jdbc;

    @Test
    void interestsSelectionBoundsReadOneAndThreeFromTheSeededRows() {
        assertThat(selectionConfig.minSelections()).isEqualTo(1);
        assertThat(selectionConfig.maxSelections()).isEqualTo(3);
    }

    @Test
    void unknownKeyFallsBackToTheSuppliedDefault() {
        // Fail-safe path: an absent key yields the caller's default, never an error.
        assertThat(appConfigService.getInt("interests.does_not_exist", 7)).isEqualTo(7);
        assertThat(appConfigService.getString("interests.does_not_exist", "fallback")).isEqualTo("fallback");
    }

    @Test
    void bothSeedRowsArePresent() {
        Integer count =
                jdbc.queryForObject(
                        "select count(*) from app_config where config_key in "
                                + "('interests.min_selections','interests.max_selections')",
                        Integer.class);
        assertThat(count).isEqualTo(2);
    }
}
