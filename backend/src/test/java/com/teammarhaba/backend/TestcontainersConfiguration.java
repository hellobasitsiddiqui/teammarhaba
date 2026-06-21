package com.teammarhaba.backend;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.testcontainers.containers.PostgreSQLContainer;

/**
 * Defines the ephemeral Postgres used by the integration-test harness.
 * {@code @ServiceConnection} wires {@code spring.datasource} to the container automatically,
 * so Flyway runs the migrations against a real Postgres on context startup.
 *
 * <p>Integration tests don't import this directly — they extend {@link AbstractIntegrationTest},
 * which imports it and standardises the {@code test}-profile convention (TM-57). Keeping the
 * container in one place means one spot to change the image or tuning.
 *
 * <p><strong>Sharing &amp; reuse:</strong> within a run the container bean is created once and
 * shared across every integration test via Spring's cached context. {@code withReuse(true)}
 * additionally keeps the container alive <em>between</em> runs for developers who opt in
 * ({@code testcontainers.reuse.enable=true} in {@code ~/.testcontainers.properties}) — a safe
 * no-op in CI, where each run gets a fresh container.
 */
@TestConfiguration(proxyBeanMethods = false)
public class TestcontainersConfiguration {

    @Bean
    @ServiceConnection
    PostgreSQLContainer<?> postgresContainer() {
        return new PostgreSQLContainer<>("postgres:16-alpine").withReuse(true);
    }
}
