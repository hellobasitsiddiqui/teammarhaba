package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;

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
}
