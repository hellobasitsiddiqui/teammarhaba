package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The TM-1067 {@code V49__venue_timezone}: an optional IANA {@code timezone} column on {@code venues}.
 *
 * <p>Flyway applies V49 on startup against the shared Testcontainers Postgres, so this asserts the
 * end-state of the shipped DDL: the migration is recorded successful, and the {@code venues.timezone}
 * column exists as a <em>nullable</em> {@code VARCHAR(64)} — nullable is the migration-safety contract
 * (every pre-existing venue backfills to NULL, no data loss, no rewrite). It also proves an existing
 * row with no timezone is unaffected. Fail-before/pass-after: on the pre-change tree there is no V49
 * and no {@code timezone} column, so both assertions fail; after the change they pass.
 */
class VenueTimezoneMigrationTest extends AbstractIntegrationTest {

    @Autowired
    private JdbcTemplate jdbc;

    @Test
    void v49IsAppliedSuccessfully() {
        Integer applied = jdbc.queryForObject(
                "select count(*) from flyway_schema_history where version = '49' and success = true",
                Integer.class);
        assertThat(applied).isEqualTo(1);
    }

    @Test
    void timezoneColumnIsNullableVarchar64() {
        var meta = jdbc.queryForMap(
                "select data_type, character_maximum_length, is_nullable "
                        + "from information_schema.columns "
                        + "where table_name = 'venues' and column_name = 'timezone'");

        assertThat(meta.get("data_type")).isEqualTo("character varying");
        assertThat(((Number) meta.get("character_maximum_length")).intValue()).isEqualTo(64);
        // NULLABLE is the migration-safety guarantee: existing rows backfill to NULL, no data loss.
        assertThat(meta.get("is_nullable")).isEqualTo("YES");
    }

    @Test
    void existingVenueRowHasNullTimezoneByDefault() {
        // A venue inserted without a timezone leaves the column NULL — the "no default to inherit"
        // state — proving the added column doesn't force a value onto pre-existing/omitting rows.
        Long creatorId = jdbc.queryForObject(
                "insert into users (firebase_uid, email) values ('v49-tz-creator', 'v49tz@example.com') returning id",
                Long.class);
        Long venueId = jdbc.queryForObject(
                "insert into venues (name, address_line, created_by, updated_at) "
                        + "values ('V49 tz venue', '1 Test Road', ?, now()) returning id",
                Long.class,
                creatorId);

        String tz = jdbc.queryForObject("select timezone from venues where id = ?", String.class, venueId);
        assertThat(tz).isNull();

        // Clean up so a shared-container re-run starts clean (no cross-test leakage).
        jdbc.update("delete from venues where id = ?", venueId);
        jdbc.update("delete from users where id = ?", creatorId);
    }
}
