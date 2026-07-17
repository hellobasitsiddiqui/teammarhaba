package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.init.ScriptUtils;

/**
 * The TM-883 data backfill ({@code V47__backfill_first_last_name}): accounts that onboarded before
 * the fix have {@code display_name} set but {@code first_name}/{@code last_name} NULL — the
 * migration splits the display name into both parts, with conservative guards.
 *
 * <p>Flyway has already applied V47 by the time any test row exists, so this test re-executes the
 * <em>shipped</em> SQL (loaded from the classpath, never a copy that could drift) against rows
 * seeded here. That's sound because the statement is idempotent by construction: its
 * {@code first_name IS NULL AND last_name IS NULL} guard makes re-running it a no-op for every row
 * it (or a user) has already named.
 */
class FirstLastNameBackfillMigrationTest extends AbstractIntegrationTest {

    @Autowired
    private JdbcTemplate jdbc;

    /** Insert a bare users row (only NOT NULL column is firebase_uid) with the given names. */
    private void seed(String uid, String displayName, String firstName, String lastName) {
        jdbc.update(
                "insert into users (firebase_uid, display_name, first_name, last_name) values (?, ?, ?, ?)",
                uid,
                displayName,
                firstName,
                lastName);
    }

    private Map<String, Object> row(String uid) {
        return jdbc.queryForMap("select first_name, last_name from users where firebase_uid = ?", uid);
    }

    private void runBackfill() {
        jdbc.execute((java.sql.Connection con) -> {
            ScriptUtils.executeSqlScript(con, new ClassPathResource("db/migration/V47__backfill_first_last_name.sql"));
            return null;
        });
    }

    @Test
    void backfillSplitsDisplayNameAndRespectsItsGuards() {
        seed("bf-two-words", "Ibn Battuta", null, null);
        seed("bf-one-word", "Sting", null, null);
        seed("bf-multi-word", "  Mary   Jane Watson ", null, null);
        seed("bf-apostrophe", "Sinead O'Connor", null, null);
        // Guard: not name-like (digits) — left alone rather than pre-filling the edit form with a
        // value its own TM-771 validation rejects.
        seed("bf-digits", "676767", null, null);
        // Guard: an explicit first/last name is a user's own data — never overwritten.
        seed("bf-explicit", "Amelia Williams", "Amelia Rose", "Pond");
        // Guard: nothing to split.
        seed("bf-no-name", null, null, null);

        runBackfill();

        assertThat(row("bf-two-words")).containsEntry("first_name", "Ibn").containsEntry("last_name", "Battuta");
        assertThat(row("bf-one-word")).containsEntry("first_name", "Sting").containsEntry("last_name", null);
        assertThat(row("bf-multi-word"))
                .containsEntry("first_name", "Mary")
                .containsEntry("last_name", "Jane Watson");
        assertThat(row("bf-apostrophe"))
                .containsEntry("first_name", "Sinead")
                .containsEntry("last_name", "O'Connor");
        assertThat(row("bf-digits")).containsEntry("first_name", null).containsEntry("last_name", null);
        assertThat(row("bf-explicit"))
                .containsEntry("first_name", "Amelia Rose")
                .containsEntry("last_name", "Pond");
        assertThat(row("bf-no-name")).containsEntry("first_name", null).containsEntry("last_name", null);
    }
}
