package com.teammarhaba.backend;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.testcontainers.containers.PostgreSQLContainer;

/**
 * Provides an ephemeral Postgres for integration tests. {@code @ServiceConnection} wires
 * {@code spring.datasource} to the container automatically, so Flyway runs the migrations
 * against a real Postgres on context startup.
 *
 * <p>Minimal wiring for TM-71 to verify itself. The full Testcontainers harness — shared
 * singleton container, reuse, and the {@code test}-profile integration-test conventions —
 * is TM-57 (which is unblocked by this ticket).
 */
@TestConfiguration(proxyBeanMethods = false)
public class TestcontainersConfiguration {

    @Bean
    @ServiceConnection
    PostgreSQLContainer<?> postgresContainer() {
        return new PostgreSQLContainer<>("postgres:16-alpine");
    }
}
