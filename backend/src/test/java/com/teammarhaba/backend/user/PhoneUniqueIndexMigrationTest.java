package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.AbstractIntegrationTest;
import java.sql.Connection;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.init.ScriptUtils;

/**
 * The TM-931 migration ({@code V48__users_phone_unique}): a dedup step that NULLs the losing rows in
 * each normalized-phone group, then a unique partial index on the normalized phone scoped to active,
 * phone-bearing rows.
 *
 * <p>Flyway has already applied V48 (against the empty container) by the time this test runs, so the
 * unique index already exists. We first DROP it, seed rows that would violate it (including a
 * soft-deleted collider), then re-execute the <em>shipped</em> SQL from the classpath (never a copy
 * that could drift) — proving the real migration dedups THEN builds the index cleanly on duplicate
 * data. Finally we assert the rebuilt index actually rejects a colliding insert.
 */
class PhoneUniqueIndexMigrationTest extends AbstractIntegrationTest {

    @Autowired
    private JdbcTemplate jdbc;

    private void seed(String uid, String phone, Instant lastActive, Instant deletedAt) {
        jdbc.update(
                "insert into users (firebase_uid, phone, last_active_at, deleted_at) values (?, ?, ?, ?)",
                uid,
                phone,
                lastActive == null ? null : java.sql.Timestamp.from(lastActive),
                deletedAt == null ? null : java.sql.Timestamp.from(deletedAt));
    }

    private String phoneOf(String uid) {
        return jdbc.queryForObject("select phone from users where firebase_uid = ?", String.class, uid);
    }

    private void runV48() {
        jdbc.execute((Connection con) -> {
            ScriptUtils.executeSqlScript(con, new ClassPathResource("db/migration/V48__users_phone_unique.sql"));
            return null;
        });
    }

    @Test
    void dedupKeepsTheDeterministicWinnerNullsLosersAndSpareTheSoftDeletedThenIndexRejectsCollisions() {
        // Drop the already-applied index so the shipped SQL can rebuild it after dedup. We do NOT wipe
        // the users table (other integration tests seeded their own uniquely-numbered rows and FK
        // children reference them); our seed rows use a test-unique number so they can't collide with
        // anything else, and V48's UPDATE only touches rows in our own normalized-phone group.
        jdbc.execute("drop index if exists users_phone_normalized_uq");

        Instant now = Instant.now();
        // A test-unique number (its own normalized group) so V48's per-group dedup can't touch or be
        // touched by any other test's rows. Three ACTIVE rows hold it in different separator shapes.
        // Winner = most recent last_active_at → "mig-winner"; the two losers get their phone NULLed.
        seed("mig-winner", "+44 7911 123001", now, null);
        seed("mig-loser-older", "+447911123001", now.minusSeconds(3600), null);
        seed("mig-loser-null-active", "+44-7911-123001", null, null); // null last_active loses (NULLS LAST)
        // A SOFT-DELETED row with the same number must be untouched (index/dedup skip deleted rows).
        seed("mig-deleted-same", "+447911123001", now, now);
        // An unrelated active number is left entirely alone.
        seed("mig-other", "+447911999002", now, null);

        runV48();

        assertThat(phoneOf("mig-winner")).isEqualTo("+44 7911 123001"); // winner keeps its phone
        assertThat(phoneOf("mig-loser-older")).isNull(); // loser NULLed
        assertThat(phoneOf("mig-loser-null-active")).isNull(); // loser NULLed
        assertThat(phoneOf("mig-deleted-same")).isEqualTo("+447911123001"); // soft-deleted untouched
        assertThat(phoneOf("mig-other")).isEqualTo("+447911999002"); // unrelated untouched

        // The rebuilt index rejects a NEW active row whose normalized phone collides with the winner.
        assertThatThrownBy(() -> seed("mig-new-collider", "+44 (7911) 123001", now, null))
                .isInstanceOf(DataIntegrityViolationException.class);

        // But a soft-deleted colliding insert is allowed (partial index excludes deleted_at IS NOT NULL).
        seed("mig-new-deleted-collider", "+447911123001", now, now);
        assertThat(phoneOf("mig-new-deleted-collider")).isEqualTo("+447911123001");
    }
}
