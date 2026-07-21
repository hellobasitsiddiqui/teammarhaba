package com.teammarhaba.backend;

import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
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

    @Autowired(required = false)
    private JdbcTemplate jdbcTemplate;

    /**
     * TM-931 test isolation: the whole integration suite shares one cached context and therefore one
     * Testcontainers Postgres, and integration tests never clean up between methods — they rely on
     * unique {@code firebase_uid}s per method so rows don't clash. That worked while {@code phone} was
     * non-unique, but V48 adds a normalized-phone UNIQUE partial index, so several pre-existing tests
     * that reuse the SAME fixture number across different accounts (e.g. {@code +44 20 7946 0958}) now
     * collide on rows LEAKED by earlier methods. Nulling every {@code users.phone} before each test
     * removes leaked rows from the partial index ({@code WHERE phone IS NOT NULL}) without deleting any
     * row (FK-safe — some children reference {@code users(id)} without {@code ON DELETE CASCADE}), so
     * every test still sets and asserts its own phone exactly as before; only cross-method fixture
     * leakage is cleared. A no-op for non-DB tests (the template is absent there).
     */
    @BeforeEach
    void clearLeakedPhonesForUniqueIndex() {
        if (jdbcTemplate != null) {
            jdbcTemplate.update("UPDATE users SET phone = NULL WHERE phone IS NOT NULL");
        }
    }
}
