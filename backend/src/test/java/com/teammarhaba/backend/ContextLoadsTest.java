package com.teammarhaba.backend;

import org.junit.jupiter.api.Test;

/**
 * Smoke test: the Spring application context starts cleanly under the {@code test} profile
 * (proves the profile + validated {@code AppProperties} boot, the Testcontainers Postgres
 * connects, and Flyway migrations apply). Uses the shared integration-test harness.
 */
class ContextLoadsTest extends AbstractIntegrationTest {

    @Test
    void contextLoads() {
        // Intentionally empty — fails if the context cannot start.
    }
}
