package com.teammarhaba.backend.interests;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Verifies the {@code interest_catalogue} seed against a real Postgres (Testcontainers): the {@code
 * V45__create_interests} migration applies and Hibernate's validate-only mapping matches the DDL (the
 * context would fail to start otherwise), the seed loaded exactly the 101 interests with exactly the six
 * intended highlights, {@code Walking} is present as a distinct highlighted interest (separate from the
 * other walk-ish labels), and the ordered listing floats the highlights to the top.
 *
 * <p>Fail-before/pass-after: this fails today (no table/entity) and passes once V45 + the entities land.
 */
class InterestCatalogueSeedIntegrationTest extends AbstractIntegrationTest {

    private static final Set<String> EXPECTED_HIGHLIGHTS =
            Set.of("Coffee & cafés", "Hiking & rambling", "Walking", "Padel", "Badminton", "Running & jogging");

    @Autowired
    private InterestCatalogueRepository repo;

    @Autowired
    private JdbcTemplate jdbc;

    @Test
    void seedLoadedExactly101Rows() {
        // Count only LIVE rows (deleted_at is null) — the shared Testcontainer is reused across the whole
        // suite with no per-test rollback, so a soft-deleted throwaway row from another test (e.g.
        // UserInterestSnapshotIntegrationTest's tombstone) can physically remain in the table. A raw
        // count(*) would include it and read 102; scoping to live rows mirrors @SQLRestriction and is
        // order-independent, so it agrees with repo.findAll() below regardless of test execution order.
        Integer dbCount =
                jdbc.queryForObject(
                        "select count(*) from interest_catalogue where deleted_at is null", Integer.class);
        assertThat(dbCount).isEqualTo(101);
        // @SQLRestriction shows every seed row (none are tombstoned), so the repo agrees with the DB.
        assertThat(repo.findAll()).hasSize(101);
    }

    @Test
    void exactlySixHighlightsAndTheyAreTheIntendedSet() {
        Integer highlightedCount =
                jdbc.queryForObject(
                        "select count(*) from interest_catalogue where highlighted = true", Integer.class);
        assertThat(highlightedCount).isEqualTo(6);

        List<String> highlightedLabels =
                jdbc.queryForList(
                        "select label from interest_catalogue where highlighted = true", String.class);
        // Assert the exact SET, not just the count — the six must be precisely the intended ones.
        assertThat(highlightedLabels).containsExactlyInAnyOrderElementsOf(EXPECTED_HIGHLIGHTS);
    }

    @Test
    void walkingIsPresentHighlightedAndDistinctFromOtherWalkishLabels() {
        List<InterestCatalogue> all = repo.findAll();

        InterestCatalogue walking =
                all.stream()
                        .filter(i -> i.getLabel().equals("Walking"))
                        .findFirst()
                        .orElseThrow(() -> new AssertionError("Walking interest is missing"));
        assertThat(walking.getCategory()).isEqualTo("Outdoors & Nature");
        assertThat(walking.isHighlighted()).isTrue();

        // All four walk-ish labels exist as four DISTINCT rows — none merged/deduped.
        List<InterestCatalogue> walkish =
                all.stream()
                        .filter(i -> Set.of("Walking", "Hiking & rambling", "Walk & talk", "Dog walks")
                                .contains(i.getLabel()))
                        .toList();
        assertThat(walkish).extracting(InterestCatalogue::getLabel)
                .containsExactlyInAnyOrder("Walking", "Hiking & rambling", "Walk & talk", "Dog walks");
        assertThat(walkish).extracting(InterestCatalogue::getId).doesNotHaveDuplicates().hasSize(4);
    }

    @Test
    void seedBackfilledAnEmojiForEveryInterestAndCoffeeGotItsCup() {
        // V46 adds the emoji column and back-fills all 101 seed rows. Assert a known label carries the
        // exact glyph, and that no LIVE seed row was left without an emoji (the back-fill covered them all).
        String coffeeEmoji =
                jdbc.queryForObject(
                        "select emoji from interest_catalogue where label = 'Coffee & cafés'", String.class);
        assertThat(coffeeEmoji).isEqualTo("☕");

        Integer missingEmoji =
                jdbc.queryForObject(
                        "select count(*) from interest_catalogue where deleted_at is null and emoji is null",
                        Integer.class);
        assertThat(missingEmoji).isZero();
    }

    @Test
    void listingFloatsHighlightsToTheTop() {
        List<InterestCatalogue> ordered = repo.findAllByOrderBySortWeightDescLabelAsc();

        // The first six entries are exactly the six highlights (their sort_weight beats every other row).
        List<String> firstSix = ordered.stream().limit(6).map(InterestCatalogue::getLabel).toList();
        assertThat(firstSix).containsExactlyInAnyOrderElementsOf(EXPECTED_HIGHLIGHTS);
        assertThat(ordered.stream().limit(6)).allMatch(InterestCatalogue::isHighlighted);

        // Every highlighted row outranks every non-highlighted row by sort_weight.
        int minHighlightWeight =
                ordered.stream().filter(InterestCatalogue::isHighlighted)
                        .mapToInt(InterestCatalogue::getSortWeight).min().orElseThrow();
        int maxOtherWeight =
                ordered.stream().filter(i -> !i.isHighlighted())
                        .mapToInt(InterestCatalogue::getSortWeight).max().orElseThrow();
        assertThat(minHighlightWeight).isGreaterThan(maxOtherWeight);
    }
}
