package com.teammarhaba.backend.interests;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The core invariant test for TM-773: a user's saved {@link UserInterest} is a FREE-TEXT SNAPSHOT that
 * is completely independent of the source {@link InterestCatalogue} row's later state. Retiring
 * (soft-delete) OR even hard-deleting the catalogue interest leaves the saved label/category and the
 * provenance {@code sourceInterestId} unchanged — because {@code source_interest_id} is a plain column
 * with no cascading foreign key.
 *
 * <p>Each test uses a freshly-inserted throwaway catalogue row (not a seeded one). The soft-delete
 * test only tombstones its row (stamps {@code deleted_at}, physically keeping it), so on the shared,
 * never-rolled-back Testcontainer that row would otherwise linger and inflate a raw {@code count(*)}
 * in {@link InterestCatalogueSeedIntegrationTest}. The {@link #cleanUpThrowawayRows() @AfterEach}
 * below hard-deletes every throwaway catalogue + user_interest row this class creates, so nothing
 * leaks into the seed-count assertions regardless of test execution order. Fail-before/pass-after.
 */
class UserInterestSnapshotIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private InterestCatalogueRepository catalogueRepo;

    @Autowired
    private UserInterestRepository userInterestRepo;

    @Autowired
    private UserRepository users;

    @Autowired
    private JdbcTemplate jdbc;

    private Long newUser(String uid) {
        return users.save(new User(uid, uid + "@example.com", uid)).getId();
    }

    /**
     * Hard-delete every throwaway row this class creates. The shared Testcontainer is reused across the
     * whole suite with no @Transactional rollback, so the soft-deleted catalogue row from the soft-delete
     * test would physically survive (tombstoned, but still counted by a raw count(*)) and pollute other
     * tests. Deleting via native SQL bypasses @SQLRestriction so it also removes the tombstoned row.
     * user_interest rows are removed first (they carry the source_interest_id provenance pointer).
     */
    @AfterEach
    void cleanUpThrowawayRows() {
        // user_interest rows are removed by owning test user (the hard-delete test already removed its
        // catalogue row, so a source-id subquery would miss its orphaned snapshot).
        jdbc.update(
                "delete from user_interest where user_id in"
                        + " (select id from users where firebase_uid like 'interest-snapshot-%')");
        // Then the throwaway catalogue rows — native delete bypasses @SQLRestriction so the tombstoned
        // soft-deleted row is removed too, which is the row that would otherwise inflate the seed count.
        jdbc.update("delete from interest_catalogue where category = 'Test Category'");
    }

    @Test
    void savedSnapshotSurvivesSoftDeleteOfItsSourceCatalogueInterest() {
        Long userId = newUser("interest-snapshot-soft");

        // A dedicated throwaway catalogue interest so mutating it doesn't disturb the seed rows.
        InterestCatalogue source =
                catalogueRepo.save(
                        new InterestCatalogue("Snapshot Test Interest", "Test Category", false, 0, Instant.now()));
        Long sourceId = source.getId();
        String copiedLabel = source.getLabel();
        String copiedCategory = source.getCategory();

        // The user picks it — we copy the label/category by value and keep a soft provenance pointer.
        userInterestRepo.save(new UserInterest(userId, copiedLabel, copiedCategory, sourceId));

        // Retire the catalogue interest (soft-delete): the @SQLRestriction now hides it from all reads.
        source.markDeleted(Instant.now());
        catalogueRepo.saveAndFlush(source);
        assertThat(catalogueRepo.findById(sourceId)).isEmpty(); // tombstoned → invisible

        // The snapshot survives entirely unchanged: label, category and the (now-retired) source id.
        List<UserInterest> saved = userInterestRepo.findByUserId(userId);
        assertThat(saved).hasSize(1);
        UserInterest snap = saved.get(0);
        assertThat(snap.getLabel()).isEqualTo(copiedLabel);
        assertThat(snap.getCategory()).isEqualTo(copiedCategory);
        assertThat(snap.getSourceInterestId()).isEqualTo(sourceId);
        assertThat(userInterestRepo.countBySourceInterestId(sourceId)).isEqualTo(1);
    }

    @Test
    void savedSnapshotSurvivesHardDeleteOfItsSourceCatalogueInterest() {
        Long userId = newUser("interest-snapshot-hard");

        InterestCatalogue source =
                catalogueRepo.save(
                        new InterestCatalogue("Hard Delete Interest", "Test Category", false, 0, Instant.now()));
        Long sourceId = source.getId();
        String copiedLabel = source.getLabel();
        String copiedCategory = source.getCategory();

        userInterestRepo.save(new UserInterest(userId, copiedLabel, copiedCategory, sourceId));

        // Hard-DELETE the catalogue row via native SQL — proves there is no DB FK cascade / set-null
        // reaching user_interest.source_interest_id (either would corrupt the snapshot).
        int removed = jdbc.update("delete from interest_catalogue where id = ?", sourceId);
        assertThat(removed).isEqualTo(1);

        List<UserInterest> saved = userInterestRepo.findByUserId(userId);
        assertThat(saved).hasSize(1);
        UserInterest snap = saved.get(0);
        assertThat(snap.getLabel()).isEqualTo(copiedLabel);
        assertThat(snap.getCategory()).isEqualTo(copiedCategory);
        // The provenance id is still the (now hard-deleted) catalogue id — untouched, not nulled.
        assertThat(snap.getSourceInterestId()).isEqualTo(sourceId);
        assertThat(userInterestRepo.countBySourceInterestId(sourceId)).isEqualTo(1);
    }
}
