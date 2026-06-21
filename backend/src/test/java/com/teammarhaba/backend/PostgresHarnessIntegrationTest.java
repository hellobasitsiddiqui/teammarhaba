package com.teammarhaba.backend;

import static org.assertj.core.api.Assertions.assertThat;

import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Sample integration test for the Testcontainers harness, and the template new integration
 * tests follow: extend {@link AbstractIntegrationTest} and autowire what you need.
 *
 * <p>It proves the point of the harness — the context boots against a <strong>real
 * Postgres</strong>, not H2 — by asserting the live connection reports PostgreSQL. This is
 * the gap the reference spec called out (H2-only testing let Postgres-specific bugs reach
 * prod); here it is closed from commit #1.
 */
class PostgresHarnessIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private DataSource dataSource;

    @Test
    void runsAgainstRealPostgres() {
        String version = jdbcTemplate.queryForObject("select version()", String.class);
        assertThat(version).contains("PostgreSQL");
    }

    @Test
    void datasourceIsWiredToTheContainer() throws Exception {
        // @ServiceConnection points spring.datasource at the Testcontainers Postgres.
        String url = dataSource.getConnection().getMetaData().getURL();
        assertThat(url).startsWith("jdbc:postgresql://");
    }
}
