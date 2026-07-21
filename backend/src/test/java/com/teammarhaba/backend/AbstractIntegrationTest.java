package com.teammarhaba.backend;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;

/**
 * Base class for integration tests that need a real database.
 *
 * <p>Boots the full application context on the isolated {@code test} profile and wires
 * {@code spring.datasource} to an ephemeral Postgres provided by Testcontainers (see
 * {@link TestcontainersConfiguration}), so the context — and Flyway's migrations — run
 * against a <strong>real Postgres, never H2</strong>. That closes the reference spec's
 * hardest-won gap: Postgres-specific behaviour is exercised from commit #1 instead of
 * leaking to prod.
 *
 * <p><strong>Convention:</strong> an integration test extends this class instead of
 * repeating the {@code @SpringBootTest} / {@code @ActiveProfiles("test")} /
 * {@code @Import(TestcontainersConfiguration.class)} trio. Because every subclass shares
 * an identical context configuration, Spring caches a single context — and therefore a
 * single Postgres container — across the whole suite, keeping it fast.
 */
@SpringBootTest
@ActiveProfiles("test")
@Import(TestcontainersConfiguration.class)
public abstract class AbstractIntegrationTest {
}
