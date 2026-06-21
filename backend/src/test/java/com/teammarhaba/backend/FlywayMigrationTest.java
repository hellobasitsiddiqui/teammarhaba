package com.teammarhaba.backend;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Verifies Flyway applies the baseline migration on startup against a fresh Postgres
 * (Testcontainers): {@code V1__init} is recorded in {@code flyway_schema_history} as a
 * successful migration. Uses the shared integration-test harness.
 */
class FlywayMigrationTest extends AbstractIntegrationTest {

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void baselineMigrationIsApplied() {
        Integer applied = jdbcTemplate.queryForObject(
                "select count(*) from flyway_schema_history where version = '1' and success = true",
                Integer.class);
        assertThat(applied).isEqualTo(1);
    }
}
