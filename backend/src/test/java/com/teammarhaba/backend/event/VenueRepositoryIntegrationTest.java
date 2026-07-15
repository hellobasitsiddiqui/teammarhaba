package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Page;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.orm.ObjectOptimisticLockingFailureException;

/**
 * Verifies {@link VenueRepository#search} against a real Postgres (Testcontainers).
 *
 * <p>Regression coverage for TM-707: the admin venues console loads with an <em>empty</em> search
 * box, i.e. {@code search(null, ...)}. Postgres type-resolves the whole predicate at plan time, so
 * an untyped null {@code :q} inside {@code concat()}/{@code lower()} defaulted to {@code bytea} and
 * blew up with {@code function lower(bytea) does not exist} — a 500 on the exact default view of
 * the console. The query now casts {@code :q} to string so the parameter is always typed text.
 */
class VenueRepositoryIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private VenueRepository venues;

    @Autowired
    private UserRepository users;

    @Autowired
    private JdbcTemplate jdbc;

    private Long creatorId;

    @BeforeEach
    void seedCreator() {
        creatorId = users.findByFirebaseUid("venue-repo-it-uid")
                .orElseGet(() -> users.saveAndFlush(new User("venue-repo-it-uid", "vrepo@example.com", "Seeder")))
                .getId();
    }

    private Venue seedVenue(String name, String city, boolean active) {
        Venue venue = new Venue(name, name + " address", creatorId, Instant.now());
        venue.setCity(city);
        venue.setActive(active);
        return venues.saveAndFlush(venue);
    }

    /**
     * TM-707: the console's default view — empty search box binds {@code q = null} — must not 500.
     *
     * <p>Faithful to the controller path: sorted, and a page size small enough that the page fills,
     * so Spring Data also fires the separate <em>count</em> query (the statement that blew up in prod
     * with {@code function lower(bytea) does not exist}).
     */
    @Test
    void searchWithNullQueryReturnsFullInventoryWithoutThrowing() {
        Venue active = seedVenue("Null-Search Hall TM707", "London", true);
        Venue inactive = seedVenue("Null-Search Hall TM707 (old)", "London", false);

        Page<Venue> page =
                venues.search(null, false, PageRequest.of(0, 1, Sort.by(Sort.Direction.DESC, "createdAt")));

        assertThat(page.getTotalElements()).isGreaterThanOrEqualTo(2);
        assertThat(venues.search(null, false, PageRequest.of(0, 100)).getContent())
                .extracting(Venue::getId)
                .contains(active.getId(), inactive.getId());
        assertThat(page.getContent()).hasSize(1);
    }

    /** The non-null path is unchanged by the cast: substring match on name or city, case-insensitive. */
    @Test
    void searchWithTextQueryStillMatchesNameAndCityCaseInsensitively() {
        Venue byName = seedVenue("Riverside Pavilion QQ707", "London", true);
        Venue byCity = seedVenue("Somewhere Else QQ707", "Qq707ville", true);
        Venue unrelated = seedVenue("Unrelated Venue XX707", "London", true);

        Page<Venue> page = venues.search("qq707", false, PageRequest.of(0, 100));

        assertThat(page.getContent())
                .extracting(Venue::getId)
                .contains(byName.getId(), byCity.getId())
                .doesNotContain(unrelated.getId());
    }

    // TM-738 P1 (venues) — two TM-114 aggregate-convention properties on the Venue entity that the
    // API/service tests don't reach directly: the @SQLRestriction soft-delete filter and the @Version
    // optimistic lock. Characterization: both are already enforced, so these PASS.

    /**
     * {@code searchExcludesSoftDeletedVenue} — the entity's {@code @SQLRestriction("deleted_at is
     * null")} must hide a tombstoned venue from {@code search} (and every normal query), independent
     * of the {@code active} flag. This is a security/data-integrity negative: a soft-deleted venue is
     * retired for good and must never resurface in the admin listing or the event-create picker, even
     * with {@code activeOnly = false} (which still returns deactivated-but-not-deleted rows). Mirrors
     * {@code UserSoftDeleteAndVersionIntegrationTest.softDeleteHidesFromNormalQueries…}.
     */
    @Test
    void searchExcludesSoftDeletedVenue() {
        Venue visible = seedVenue("Soft-Delete Probe VISIBLE SD811", "London", true);
        Venue tombstoned = seedVenue("Soft-Delete Probe TOMBSTONED SD811", "London", true);

        // Tombstone one venue by stamping deleted_at directly (the entity intentionally exposes no
        // soft-delete setter — venues are retired via `active`, not hard-deleted). The house test
        // idiom for tombstoning a row whose entity has no deletedAt setter is a native update (mirrors
        // e.g. EventAttendanceRepositoryIntegrationTest's `update users set deleted_at = now()`); the
        // entity's @SQLRestriction then excludes it from every read below.
        jdbc.update("update venues set deleted_at = now() where id = ?", tombstoned.getId());

        // Even the full-inventory search (activeOnly = false, so it would otherwise include
        // deactivated rows) must NOT return the soft-deleted venue — only the visible one.
        Page<Venue> page = venues.search("SD811", false, PageRequest.of(0, 100));
        assertThat(page.getContent())
                .extracting(Venue::getId)
                .contains(visible.getId())
                .doesNotContain(tombstoned.getId());

        // And a direct findById of the tombstoned row is empty too — the restriction is global, not
        // just on the custom search query.
        assertThat(venues.findById(tombstoned.getId())).isEmpty();
    }

    /**
     * {@code concurrentStaleUpdateReturns409} — the {@code @Version} column gives the venue the house
     * optimistic-lock guarantee: two writers that both loaded the same version can't silently clobber
     * each other. The first write wins (bumps the version); the second, now stale, fails the version
     * check with {@link ObjectOptimisticLockingFailureException} — which
     * {@code GlobalExceptionHandler.handleOptimisticLock} maps to an HTTP {@code 409 Conflict} at the
     * API boundary. Mirrors {@code UserSoftDeleteAndVersionIntegrationTest.staleUpdateFailsWith…}.
     */
    @Test
    void concurrentStaleUpdateReturns409() {
        Venue seeded = seedVenue("Optimistic Lock Probe OL811", "London", true);
        Long id = seeded.getId();

        // Two independent loads (each detached) ⇒ two copies at the same version.
        Venue stale = venues.findById(id).orElseThrow();
        Venue fresh = venues.findById(id).orElseThrow();

        // First writer wins: bumps version 0 -> 1.
        fresh.setName("first writer wins");
        venues.saveAndFlush(fresh);
        assertThat(venues.findById(id).orElseThrow().getVersion()).isGreaterThan(stale.getVersion());

        // Second writer is now stale — its version no longer matches, so the write is rejected rather
        // than overwriting the first writer's change. This is the exception the API translates to 409.
        stale.setName("second writer is stale");
        assertThatThrownBy(() -> venues.saveAndFlush(stale))
                .isInstanceOf(ObjectOptimisticLockingFailureException.class);
    }

    // TM-738 P2 (venues) — two edge/boundary properties the existing suite doesn't isolate: the
    // city-only branch of the search predicate, and the DB-level capacity CHECK. Characterization:
    // both already hold, so these PASS with no source change.

    /**
     * {@code searchMatchesCityIndependentOfName} — the search predicate is a name-OR-city match
     * ({@code lower(v.name) like … or lower(v.city) like …}), so a query that appears ONLY in a
     * venue's city (and nowhere in its name) must still find it. The existing
     * {@code searchWithTextQueryStillMatchesNameAndCityCaseInsensitively} proves both branches fire in
     * one run, but its {@code byCity} row happens to carry the same "QQ707" token that also matches its
     * name-branch sibling — so it doesn't isolate the city branch on its own. This pins the city OR-arm
     * independently: the search token is absent from every name here and present only in the city.
     */
    @Test
    void searchMatchesCityIndependentOfName() {
        // Match token "CityOnly812" lives in the city, never in a name — so a hit can only come via the
        // city branch of the predicate, not the name branch.
        Venue byCity = seedVenue("Northgate Rooms NG812", "CityOnly812borough", true);
        // A control whose NAME contains the token would (wrongly) pass a name-only search — but here
        // neither name nor city carries "CityOnly812", so it must be excluded.
        Venue neither = seedVenue("Northgate Rooms NG812 (annex)", "London", true);

        Page<Venue> page = venues.search("cityonly812", false, PageRequest.of(0, 100));

        assertThat(page.getContent())
                .extracting(Venue::getId)
                .contains(byCity.getId()) // found purely by its city
                .doesNotContain(neither.getId()); // token in neither field ⇒ excluded
    }

    /**
     * {@code capacityBelowOneRejectedAtDbCheck} — defence in depth behind the API's {@code @Min(1)}:
     * the {@code CHECK (capacity IS NULL OR capacity >= 1)} constraint (V41) means the DB itself
     * refuses to store a sub-1 capacity, whatever code path writes it — so a bad value can never slip
     * in past the Bean-Validation layer (e.g. a future direct-repository writer). NULL (unspecified)
     * and any value {@code >= 1} stay valid. Mirrors
     * {@code EventRepositoryIntegrationTest.databaseRejectsANonPositiveCapacity} for the event table.
     */
    @Test
    void capacityBelowOneRejectedAtDbCheck() {
        Venue zeroCap = new Venue("Zero-Cap Hall ZC812", "Zero-Cap Hall ZC812 address", creatorId, Instant.now());
        zeroCap.setCapacity(0);

        // The CHECK fires at flush time; Spring translates the SQL constraint violation to
        // DataIntegrityViolationException.
        assertThatThrownBy(() -> venues.saveAndFlush(zeroCap)).isInstanceOf(DataIntegrityViolationException.class);
    }
}
