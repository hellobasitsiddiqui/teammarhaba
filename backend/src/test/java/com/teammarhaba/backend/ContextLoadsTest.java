package com.teammarhaba.backend;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;

/**
 * Smoke test: the Spring application context starts cleanly under the {@code test} profile
 * (proves the profile + validated {@code AppProperties} boot, the Testcontainers Postgres
 * connects, and Flyway migrations apply).
 */
@SpringBootTest
@ActiveProfiles("test")
@Import(TestcontainersConfiguration.class)
class ContextLoadsTest {

    @Test
    void contextLoads() {
        // Intentionally empty — fails if the context cannot start.
    }
}
