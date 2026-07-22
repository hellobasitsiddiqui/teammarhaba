package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.init.ScriptUtils;

/**
 * The TM-934 {@code V48__dedup_phone_and_unique_index}: DEDUP the pre-uniqueness world (NULL the
 * losers in each normalized-phone group among active, non-deleted rows) then a normalized-phone
 * partial UNIQUE index {@code users_phone_normalized_uq} ({@code WHERE phone IS NOT NULL AND
 * deleted_at IS NULL}).
 *
 * <p>Flyway has already applied V48 by the time any test row exists, so to exercise the dedup half
 * against real duplicates we must first DROP the index (duplicates cannot be inserted while it
 * holds), seed the colliding pre-migration state, then re-execute the <em>shipped</em> SQL (loaded
 * from the classpath — never a drifting copy). The script is re-runnable on a fresh DB by
 * construction: the dedup is idempotent (already-deduped data is a no-op) and it recreates the same
 * index. Each test restores the migrated end-state so ordering never matters.
 */
class PhoneUniqueIndexMigrationTest extends AbstractIntegrationTest {

    private static final String INDEX = "users_phone_normalized_uq";

    @Autowired
    private JdbcTemplate jdbc;

    /** Insert a users row (firebase_uid is the only NOT NULL identity column) with a raw phone. */
    private long seed(String uid, String phone, boolean deleted) {
        return jdbc.queryForObject(
                "insert into users (firebase_uid, phone, deleted_at) values (?, ?, ?) returning id",
                Long.class,
                uid,
                phone,
                deleted ? java.sql.Timestamp.from(java.time.Instant.now()) : null);
    }

    private String phoneOf(String uid) {
        return jdbc.queryForObject("select phone from users where firebase_uid = ?", String.class, uid);
    }

    private void dropIndex() {
        jdbc.execute("DROP INDEX IF EXISTS " + INDEX);
    }

    /** Re-run the shipped migration SQL (dedup + recreate index) exactly as Flyway would. */
    private void runMigration() {
        jdbc.execute((java.sql.Connection con) ->
                ScriptUtils.executeSqlScript(
                                con,
                                new ClassPathResource("db/migration/V48__dedup_phone_and_unique_index.sql"))
                        + 0);
    }

    private boolean indexExists() {
        Integer n = jdbc.queryForObject(
                "select count(*) from pg_indexes where indexname = ?", Integer.class, INDEX);
        return n != null && n > 0;
    }

    @Test
    void dedupKeepsTheOldestRowAndNullsTheLosersDeterministically() {
        dropIndex();
        // A normalized-phone group written three ways (bare, spaced, no-plus) — all the SAME number.
        // The smallest id (oldest, seeded first) is the deterministic winner; the rest are NULLed.
        long winner = seed("dedup-winner", "+447700900123", false);
        long loserSpaced = seed("dedup-loser-spaced", "+44 7700 900123", false);
        long loserNoPlus = seed("dedup-loser-noplus", "447700900123", false);
        // A different number is left completely alone.
        seed("dedup-other", "+447700900555", false);
        // A soft-deleted row sharing the winner's number is OUTSIDE the partial index: it must NOT be
        // NULLed (it is neither winner nor loser) and it must NOT force the live winner to be NULLed.
        seed("dedup-soft-deleted", "+447700900123", true);

        assertThat(winner).isLessThan(loserSpaced).isLessThan(loserNoPlus);

        runMigration();

        assertThat(phoneOf("dedup-winner")).isEqualTo("+447700900123");
        assertThat(phoneOf("dedup-loser-spaced")).isNull();
        assertThat(phoneOf("dedup-loser-noplus")).isNull();
        assertThat(phoneOf("dedup-other")).isEqualTo("+447700900555");
        // Soft-deleted row keeps its phone untouched.
        assertThat(phoneOf("dedup-soft-deleted")).isEqualTo("+447700900123");
        // The index is back in place after the migration reran.
        assertThat(indexExists()).isTrue();

        cleanup();
    }

    @Test
    void indexRejectsACollidingInsertIncludingDifferentFormatting() {
        // The index is live (Flyway applied it); a second active row with the same NORMALIZED phone
        // is rejected even when formatted differently (separators / missing '+').
        seed("uq-first", "+447700900222", false);

        assertThatThrownBy(() -> seed("uq-second-spaced", "+44 7700 900222", false))
                .isInstanceOf(DataIntegrityViolationException.class);

        // But a NULL phone never collides (many accounts have no phone), and a soft-deleted duplicate
        // is allowed (its number is freed) — neither is in the partial index.
        seed("uq-null-a", null, false);
        seed("uq-null-b", null, false);
        seed("uq-softdel-dup", "+447700900222", true);

        assertThat(phoneOf("uq-first")).isEqualTo("+447700900222");

        cleanup();
    }

    /** Remove this test's rows so a shared-container re-run starts clean (no cross-test leakage). */
    private void cleanup() {
        jdbc.update("delete from users where firebase_uid like 'dedup-%' or firebase_uid like 'uq-%'");
    }
}
