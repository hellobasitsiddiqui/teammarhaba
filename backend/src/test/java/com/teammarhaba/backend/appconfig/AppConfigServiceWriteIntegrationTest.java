package com.teammarhaba.backend.appconfig;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The {@link AppConfigService#setInt} write path added in TM-774: the update branch (existing seeded
 * row) and the insert branch (a brand-new key). The existing-row test uses the shared V45 seed key and
 * resets it to its default in {@code @AfterEach}; the new-key test uses a throwaway key and deletes it.
 */
class AppConfigServiceWriteIntegrationTest extends AbstractIntegrationTest {

    private static final String THROWAWAY_KEY = "interests.test_key.tm774";

    @Autowired
    private AppConfigService appConfig;

    @Autowired
    private JdbcTemplate jdbc;

    @AfterEach
    void cleanUp() {
        // Reset the shared seed key to its V45 default and remove the throwaway key.
        appConfig.setInt("interests.max_selections", 3);
        jdbc.update("delete from app_config where config_key = ?", THROWAWAY_KEY);
    }

    @Test
    void setIntUpdatesExistingRow() {
        appConfig.setInt("interests.max_selections", 7);
        assertThat(appConfig.getInt("interests.max_selections", -1)).isEqualTo(7);

        // No duplicate row was inserted — the seed row was updated in place.
        Integer count = jdbc.queryForObject(
                "select count(*) from app_config where config_key = ?", Integer.class, "interests.max_selections");
        assertThat(count).isEqualTo(1);
    }

    @Test
    void setIntCreatesRowWhenAbsent() {
        assertThat(appConfig.getInt(THROWAWAY_KEY, -1)).isEqualTo(-1); // absent → default

        appConfig.setInt(THROWAWAY_KEY, 9);

        assertThat(appConfig.getInt(THROWAWAY_KEY, -1)).isEqualTo(9);
    }
}
