package com.teammarhaba.backend.interests;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditRepository;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.ProfileUpdate;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.user.UserService;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * TM-775 snapshot invariant at the service layer: an interest saved through the
 * {@code UserService.updateProfile} replace path is a FREE-TEXT SNAPSHOT that survives an admin
 * retiring (soft-delete) OR hard-deleting the source catalogue interest — the label/category and the
 * {@code sourceInterestId} stay put, and no cascade removes the row. This complements
 * {@link UserInterestSnapshotIntegrationTest} (which builds the snapshot directly): here the snapshot
 * is created via the real {@code PATCH /me} write path, proving the API preserves the invariant.
 *
 * <p>Each test uses a throwaway active catalogue row (category {@code "Test Category"}) so mutating it
 * never disturbs the seed rows. The {@link #cleanUp() @AfterEach} native-deletes this class's rows from
 * the shared, never-rolled-back container (bypassing {@code @SQLRestriction} so a tombstoned row goes
 * too), keeping the seed-count assertions elsewhere honest.
 */
class UserInterestReplaceSnapshotIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private UserService userService;

    @Autowired
    private InterestCatalogueRepository catalogueRepo;

    @Autowired
    private UserInterestRepository userInterestRepo;

    @Autowired
    private UserRepository users;

    @Autowired
    private AuditRepository audit;

    @Autowired
    private JdbcTemplate jdbc;

    @AfterEach
    void cleanUp() {
        jdbc.update(
                "delete from user_interest where user_id in"
                        + " (select id from users where firebase_uid like 'interest-replace-%')");
        jdbc.update("delete from interest_catalogue where category = 'Test Category'");
        // NB: audit_events is DB-enforced append-only (a block-mutation trigger rejects DELETE), so we
        // deliberately leave this class's PROFILE_UPDATED rows in place. They're keyed by these unique
        // per-test uids and no suite counts audit rows globally, so the residue is harmless.
    }

    private VerifiedUser provision(String uid) {
        VerifiedUser caller = new VerifiedUser(uid, uid + "@example.com");
        userService.provision(caller); // create the users row so the pick can be saved against it
        return caller;
    }

    /** Pick the throwaway label through the real replace path, returning the saved snapshot. */
    private UserInterest pick(VerifiedUser caller, String label) {
        userService.updateProfile(
                caller,
                new ProfileUpdate(null, null, null, null, null, null, null, null, null, null, null, List.of(label)));
        User user = users.findByFirebaseUid(caller.uid()).orElseThrow();
        List<UserInterest> saved = userInterestRepo.findByUserId(user.getId());
        assertThat(saved).hasSize(1);
        return saved.get(0);
    }

    /** Save the given interest label set through the real replace path (PATCH /me backing). */
    private void saveInterests(VerifiedUser caller, List<String> labels) {
        userService.updateProfile(
                caller,
                new ProfileUpdate(null, null, null, null, null, null, null, null, null, null, null, labels));
    }

    /** How many PROFILE_UPDATED audit rows this caller's account has accrued (change-detection oracle). */
    private long profileUpdatedCount(String uid) {
        return audit
                .findByTargetTypeAndTargetIdAndAction("User", uid, AuditAction.PROFILE_UPDATED, PageRequest.of(0, 1))
                .getTotalElements();
    }

    /**
     * TM-874 regression: re-saving the SAME interest set (in any order) is a true no-op — it must NOT
     * delete-and-reinsert the snapshot rows and must NOT log a spurious {@code PROFILE_UPDATED} diff.
     *
     * <p>Before the fix, {@code replaceInterests} compared {@code findByUserId(...)} (unordered) against
     * the requested list with an order-sensitive {@code List.equals}, so an identical re-save in a
     * different order looked like a change: it unconditionally {@code deleteAll} + re-{@code save}d every
     * row (fresh {@code IDENTITY} ids + {@code created_at}) and appended an interests audit diff. The row
     * ids being unchanged after the re-save proves no delete/reinsert happened; the audit count staying
     * put proves no diff was recorded. Fails on the old order-sensitive comparison, passes on the set one.
     */
    @Test
    void reSavingTheSameInterestSetInAnyOrderIsANoOpWithNoDeleteReinsertOrAuditDiff() {
        VerifiedUser caller = provision("interest-replace-noop");
        // Two throwaway active catalogue rows so the set has an order to permute (min 1 / max 3 config).
        catalogueRepo.save(new InterestCatalogue("Noop Alpha", "Test Category", false, 0, Instant.now()));
        catalogueRepo.save(new InterestCatalogue("Noop Beta", "Test Category", false, 0, Instant.now()));

        // First save establishes the set. Records exactly one PROFILE_UPDATED (the interests diff).
        saveInterests(caller, List.of("Noop Alpha", "Noop Beta"));
        Long userId = users.findByFirebaseUid(caller.uid()).orElseThrow().getId();

        List<UserInterest> afterFirst = userInterestRepo.findByUserId(userId);
        assertThat(afterFirst).hasSize(2);
        // The row ids assigned on the first insert — a delete/reinsert would replace these with new ones.
        List<Long> idsAfterFirst = afterFirst.stream().map(UserInterest::getId).sorted().toList();
        long auditAfterFirst = profileUpdatedCount(caller.uid());
        assertThat(auditAfterFirst).isGreaterThanOrEqualTo(1); // the initial set was a real change

        // Re-save the SAME two labels, but in the OPPOSITE order → must be detected as unchanged.
        saveInterests(caller, List.of("Noop Beta", "Noop Alpha"));

        // No delete/reinsert: the exact same rows (same ids) survive the no-op re-save.
        List<UserInterest> afterReSave = userInterestRepo.findByUserId(userId);
        List<Long> idsAfterReSave = afterReSave.stream().map(UserInterest::getId).sorted().toList();
        assertThat(idsAfterReSave)
                .as("a same-set re-save must not delete-and-reinsert rows (ids are stable)")
                .isEqualTo(idsAfterFirst);

        // No spurious audit diff: the PROFILE_UPDATED count is unchanged by the no-op re-save.
        assertThat(profileUpdatedCount(caller.uid()))
                .as("a same-set re-save must not log a PROFILE_UPDATED diff")
                .isEqualTo(auditAfterFirst);
    }

    @Test
    void savedInterestSurvivesAdminSoftDeletingTheSourceCatalogueInterest() {
        VerifiedUser caller = provision("interest-replace-soft");
        InterestCatalogue source = catalogueRepo.save(
                new InterestCatalogue("Replace Soft Interest", "Test Category", false, 0, Instant.now()));
        Long sourceId = source.getId();

        UserInterest snap = pick(caller, source.getLabel());
        assertThat(snap.getSourceInterestId()).isEqualTo(sourceId);

        // Admin retires the catalogue row via soft-delete: @SQLRestriction now hides it everywhere.
        source.markDeleted(Instant.now());
        catalogueRepo.saveAndFlush(source);
        assertThat(catalogueRepo.findById(sourceId)).isEmpty();

        // The snapshot is entirely unchanged, and the soft pointer count is intact (no cascade).
        Long userId = users.findByFirebaseUid(caller.uid()).orElseThrow().getId();
        List<UserInterest> saved = userInterestRepo.findByUserId(userId);
        assertThat(saved).hasSize(1);
        assertThat(saved.get(0).getLabel()).isEqualTo("Replace Soft Interest");
        assertThat(saved.get(0).getCategory()).isEqualTo("Test Category");
        assertThat(saved.get(0).getSourceInterestId()).isEqualTo(sourceId);
        assertThat(userInterestRepo.countBySourceInterestId(sourceId)).isEqualTo(1);
    }

    @Test
    void savedInterestSurvivesAdminHardDeletingTheSourceCatalogueInterest() {
        VerifiedUser caller = provision("interest-replace-hard");
        InterestCatalogue source = catalogueRepo.save(
                new InterestCatalogue("Replace Hard Interest", "Test Category", false, 0, Instant.now()));
        Long sourceId = source.getId();

        UserInterest snap = pick(caller, source.getLabel());
        assertThat(snap.getSourceInterestId()).isEqualTo(sourceId);

        // Hard-DELETE the catalogue row: proves there is no FK cascade / set-null onto the snapshot.
        int removed = jdbc.update("delete from interest_catalogue where id = ?", sourceId);
        assertThat(removed).isEqualTo(1);

        Long userId = users.findByFirebaseUid(caller.uid()).orElseThrow().getId();
        List<UserInterest> saved = userInterestRepo.findByUserId(userId);
        assertThat(saved).hasSize(1);
        assertThat(saved.get(0).getLabel()).isEqualTo("Replace Hard Interest");
        assertThat(saved.get(0).getCategory()).isEqualTo("Test Category");
        assertThat(saved.get(0).getSourceInterestId()).isEqualTo(sourceId);
        assertThat(userInterestRepo.countBySourceInterestId(sourceId)).isEqualTo(1);
    }
}
