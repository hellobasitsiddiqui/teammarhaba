package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.AbstractIntegrationTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * TM-975 — DB uniqueness hardening: lock the DEFENSE-IN-DEPTH invariant that the verified phone is
 * unique among active accounts, as a first-class regression guard that OUTLIVES whichever migration
 * happens to create the index.
 *
 * <p><strong>Why this test exists separately from {@link PhoneUniqueIndexMigrationTest}.</strong>
 * The partial-UNIQUE index on the normalized phone was actually shipped by
 * {@code V48__dedup_phone_and_unique_index} (TM-934, PR #639, merged 2026-07-22) — that migration
 * arrived a day before TM-975 was picked up and already delivers the exact schema constraint TM-975
 * was written to add (see the PR body for the full ticket-graph reconciliation). {@code
 * PhoneUniqueIndexMigrationTest} is scoped to V48's <em>mechanism</em> (it drops the index, seeds the
 * pre-uniqueness world, re-runs the dedup step, and asserts the deterministic winner survives). This
 * test instead pins the <em>invariant TM-975 owns</em>: whatever migration created it, the live DB
 * must reject a second active row with the same normalized phone and must exempt NULL and
 * soft-deleted rows. So if a future migration edit ever drops or weakens {@code
 * users_phone_normalized_uq}, THIS test fails — the constraint can't silently regress out from under
 * the identity guarantee (TM-973 #2: one verified number = one account).
 *
 * <p>No new migration is added by TM-975: a second UNIQUE index on {@code users.phone} would be
 * redundant with V48's (which is stricter — it normalizes formatting), and a UNIQUE index that did
 * NOT match V48's normalization could even fail to build over V48's survivors. The additive value of
 * TM-975 is this guard test plus the documented reconciliation of the ticket graph.
 *
 * <p>The index is already live (Flyway applied V48 at context startup), so this test only INSERTs
 * against the applied schema — it never re-runs migration DDL. An {@code @AfterEach} hook removes each
 * test's seeded rows so a shared-container re-run starts clean AND — critically — so a FAILING
 * assertion doesn't leak its half-seeded rows into a sibling test (TM-1019: cleanup used to run inline
 * at the end of the test body, so it was skipped exactly when an assertion threw).
 */
class PhoneUniqueInvariantTest extends AbstractIntegrationTest {

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

    private boolean indexExists() {
        Integer n = jdbc.queryForObject(
                "select count(*) from pg_indexes where indexname = ?", Integer.class, INDEX);
        return n != null && n > 0;
    }

    @Test
    void theVerifiedPhoneUniqueIndexIsPresentInTheAppliedSchema() {
        // Defense-in-depth precondition: the partial-UNIQUE index must exist on the live schema.
        // (Created by V48 today; this assertion is agnostic to WHICH migration created it.)
        assertThat(indexExists()).isTrue();
    }

    @Test
    void aSecondActivePhoneIsRejectedWithDataIntegrityViolation() {
        // The core TM-975 invariant: a duplicate ACTIVE (non-soft-deleted) phone INSERT is refused
        // by the DB, independent of Firebase — even when the two numbers differ only by formatting
        // (separators / a missing leading '+'), because the index compares digits only.
        seed("inv-first", "+447700900321", false);

        assertThatThrownBy(() -> seed("inv-second-exact", "+447700900321", false))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> seed("inv-second-spaced", "+44 7700 900321", false))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void nullAndSoftDeletedPhonesAreExemptFromUniqueness() {
        // Exemptions that keep the partial index correct for real data:
        //  - MANY accounts legitimately have no phone yet -> NULL never collides.
        //  - A soft-deleted account's number is freed for a live account to (re)claim -> a
        //    soft-deleted duplicate of a live number is allowed.
        seed("inv-live", "+447700900654", false);

        // NULL phones: any number of them coexist.
        seed("inv-null-a", null, false);
        seed("inv-null-b", null, false);

        // A soft-deleted row carrying the SAME number as the live one is outside the partial index.
        long softDup = seed("inv-softdel-dup", "+447700900654", true);
        assertThat(softDup).isPositive();

        // And the live number is still protected against another ACTIVE duplicate.
        assertThatThrownBy(() -> seed("inv-live-dup", "+447700900654", false))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    /**
     * Remove every seeded row AFTER each test — runs even when a test's assertion throws, so a
     * failing test can't leak its half-seeded {@code inv-%} rows into a sibling test (which would then
     * see a spurious duplicate-phone collision). {@code @AfterEach} is the guarantee the old inline
     * end-of-body cleanup could not give (TM-1019).
     */
    @AfterEach
    void cleanup() {
        jdbc.update("delete from users where firebase_uid like 'inv-%'");
    }
}
