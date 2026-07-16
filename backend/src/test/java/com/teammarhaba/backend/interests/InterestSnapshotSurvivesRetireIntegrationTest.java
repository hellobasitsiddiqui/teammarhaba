package com.teammarhaba.backend.interests;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * TM-774: the TM-773 snapshot invariant must hold through the NEW admin retire path — retiring an
 * interest via {@link InterestAdminService#retire} soft-deletes the catalogue row but leaves every
 * user's {@link UserInterest} snapshot byte-for-byte unchanged (and never hard-deletes the row).
 *
 * <p>Mirrors {@code UserInterestSnapshotIntegrationTest}'s cleanup: throwaway rows use a dedicated
 * {@code category}/uid prefix and are hard-deleted (native, bypassing {@code @SQLRestriction}) in an
 * {@code @AfterEach}, so a tombstoned throwaway row can't linger and inflate the seed-count assertions
 * in sibling suites.
 */
class InterestSnapshotSurvivesRetireIntegrationTest extends AbstractIntegrationTest {

    private static final String TEST_CATEGORY = "TM774 Retire Category";

    @Autowired
    private InterestAdminService adminService;

    @Autowired
    private InterestCatalogueRepository catalogue;

    @Autowired
    private UserInterestRepository userInterests;

    @Autowired
    private UserRepository users;

    @Autowired
    private JdbcTemplate jdbc;

    @AfterEach
    void cleanUpThrowawayRows() {
        jdbc.update("delete from user_interest where user_id in"
                + " (select id from users where firebase_uid like 'tm774-retire-%')");
        jdbc.update("delete from interest_catalogue where category = ?", TEST_CATEGORY);
    }

    private static VerifiedUser adminCaller() {
        return new VerifiedUser("tm774-retire-admin", "tm774-retire-admin@example.com");
    }

    @Test
    void retiringInterestViaAdminServiceLeavesUserSnapshotsUntouched() {
        Long userId = users.save(new User("tm774-retire-user", "tm774-retire-user@example.com", "Retire User"))
                .getId();

        // A throwaway active catalogue interest the user "picks".
        InterestCatalogue source = catalogue.saveAndFlush(
                new InterestCatalogue("Retire Snapshot Interest", TEST_CATEGORY, false, 0, Instant.now()));
        Long sourceId = source.getId();
        String copiedLabel = source.getLabel();
        String copiedCategory = source.getCategory();
        userInterests.save(new UserInterest(userId, copiedLabel, copiedCategory, sourceId));

        // Retire it through the NEW admin service path (not the entity method directly).
        adminService.retire(adminCaller(), sourceId);

        // The catalogue row is now tombstoned — invisible to the restriction-honouring read ...
        assertThat(catalogue.findById(sourceId)).isEmpty();

        // ... but the user's snapshot survives entirely unchanged.
        List<UserInterest> saved = userInterests.findByUserId(userId);
        assertThat(saved).hasSize(1);
        UserInterest snap = saved.get(0);
        assertThat(snap.getLabel()).isEqualTo(copiedLabel);
        assertThat(snap.getCategory()).isEqualTo(copiedCategory);
        assertThat(snap.getSourceInterestId()).isEqualTo(sourceId);
        assertThat(userInterests.countBySourceInterestId(sourceId)).isEqualTo(1);
    }

    @Test
    void retireNeverHardDeletesTheCatalogueRow() {
        InterestCatalogue source = catalogue.saveAndFlush(
                new InterestCatalogue("Kept After Retire", TEST_CATEGORY, false, 0, Instant.now()));
        Long sourceId = source.getId();

        adminService.retire(adminCaller(), sourceId);

        // The row is kept (tombstoned), not hard-deleted: a native count sees it (bypasses @SQLRestriction).
        Integer rows =
                jdbc.queryForObject("select count(*) from interest_catalogue where id = ?", Integer.class, sourceId);
        assertThat(rows).isEqualTo(1);
    }
}
