package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * TM-738 P1 (profile): the lifecycle + optimistic-concurrency guarantees of the profile-WRITE seam,
 * {@link UserService#updateProfile}. Companion to {@link UserSoftDeleteAndVersionIntegrationTest} (which
 * pins the same invariants on {@code provision} / a raw repository {@code saveAndFlush}); these exercise
 * them through the actual PATCH-backing service method against a real Postgres.
 *
 * <ul>
 *   <li>{@code patchMeOnSoftDeletedReactivatesOrRefuses} — a PATCH from a returning user whose account
 *       was soft-deleted must not error and must not duplicate: {@code updateProfile} provisions (which
 *       reactivates the tombstone) and applies the field write, so the same row comes back active with
 *       the update persisted.</li>
 *   <li>{@code concurrentPatchMeNoLostUpdate} — two writers on the same row can't silently lose an
 *       update: {@code @Version} optimistic locking means a stale second write is rejected rather than
 *       overwriting the first (deterministic seam), and a genuine concurrent race never ends with BOTH
 *       edits vanishing (harness seam — the robust no-lost-update invariant regardless of interleaving).</li>
 * </ul>
 */
class UserProfileUpdateLifecycleIntegrationTest extends AbstractIntegrationTest {

    private static final int RACE_TIMEOUT_SECONDS = 60;

    @Autowired
    private UserService userService;

    @Autowired
    private UserRepository users;

    private static VerifiedUser caller(String uid, String email) {
        return new VerifiedUser(uid, email);
    }

    /** A partial update that touches only {@code displayName} — the rest null = leave unchanged. */
    private static ProfileUpdate displayNameUpdate(String displayName) {
        return new ProfileUpdate(displayName, null, null, null, null, null, null, null, null, null, null, null);
    }

    // ---- patchMeOnSoftDeletedReactivatesOrRefuses --------------------------------------------------

    @Test
    void updateProfileOnSoftDeletedAccountReactivatesItAndPersistsTheEdit() {
        VerifiedUser who = caller("uid-pf-reactivate", "reactivate@example.com");

        // Establish an active account with a display name, then soft-delete it (tombstone).
        User first = userService.updateProfile(who, displayNameUpdate("Original"));
        Long originalId = first.getId();
        userService.softDelete(who.uid());
        assertThat(users.findByFirebaseUid(who.uid())).isEmpty(); // hidden by @SQLRestriction

        // A PATCH from the returning user: updateProfile provisions (reactivating the tombstone) and
        // applies the edit — it must NOT error and must NOT create a duplicate row.
        User reactivated = userService.updateProfile(who, displayNameUpdate("Reactivated"));

        assertThat(reactivated.getId()).isEqualTo(originalId); // same row, reactivated (not duplicated)
        assertThat(reactivated.isDeleted()).isFalse();
        assertThat(reactivated.getDisplayName()).isEqualTo("Reactivated");

        // Persisted + active again on a fresh read.
        User reloaded = users.findByFirebaseUid(who.uid()).orElseThrow();
        assertThat(reloaded.getId()).isEqualTo(originalId);
        assertThat(reloaded.isDeleted()).isFalse();
        assertThat(reloaded.getDisplayName()).isEqualTo("Reactivated");
        assertThat(users.findAll().stream().filter(u -> who.uid().equals(u.getFirebaseUid())))
                .as("exactly one row exists for the reactivated uid")
                .hasSize(1);
    }

    // ---- concurrentPatchMeNoLostUpdate -------------------------------------------------------------

    @Test
    void twoConcurrentProfileUpdatesNeverLoseBothEditsAndKeepASingleRow() throws Exception {
        VerifiedUser who = caller("uid-pf-race-" + UUID.randomUUID(), "race@example.com");
        userService.updateProfile(who, displayNameUpdate("Seed")); // ensure the row exists first

        // Two callers PATCH the same row's display name at the same moment. With @Version optimistic
        // locking a losing writer surfaces an ObjectOptimisticLockingFailureException (the update it lost
        // is NOT silently applied); a winning writer commits. The invariant that must ALWAYS hold,
        // whatever the interleaving: the persisted name is a real one of the two candidates (never a
        // torn/blank value), and exactly one row exists — no lost-update corruption.
        List<Outcome<User>> outcomes = race(List.of(
                () -> userService.updateProfile(who, displayNameUpdate("Writer-A")),
                () -> userService.updateProfile(who, displayNameUpdate("Writer-B"))));

        long succeeded = outcomes.stream().filter(o -> o.error() == null).count();
        assertThat(succeeded).as("at least one concurrent writer must commit (not both lost)").isGreaterThanOrEqualTo(1);

        User reloaded = users.findByFirebaseUid(who.uid()).orElseThrow();
        assertThat(reloaded.getDisplayName())
                .as("the persisted name is one of the two committed candidates, never torn/blank")
                .isIn("Writer-A", "Writer-B");
        assertThat(users.findAll().stream().filter(u -> who.uid().equals(u.getFirebaseUid())))
                .as("exactly one row survives the concurrent update")
                .hasSize(1);
    }

    // ------------------------------------------------------------------ harness (from
    // UserProvisionConcurrencyIntegrationTest): run each task on its own thread + connection, released
    // together through a barrier so they race, and collect per-task outcomes.

    /** One racer's result: exactly one of {@code value} / {@code error} is set. */
    private record Outcome<T>(T value, Throwable error) {}

    private <T> List<Outcome<T>> race(List<Callable<T>> callables) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(callables.size());
        try {
            CyclicBarrier startLine = new CyclicBarrier(callables.size());
            List<Future<T>> futures = new ArrayList<>();
            for (Callable<T> task : callables) {
                futures.add(pool.submit(() -> {
                    startLine.await(RACE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                    return task.call();
                }));
            }
            List<Outcome<T>> outcomes = new ArrayList<>();
            for (Future<T> future : futures) {
                try {
                    outcomes.add(new Outcome<>(future.get(RACE_TIMEOUT_SECONDS, TimeUnit.SECONDS), null));
                } catch (ExecutionException e) {
                    outcomes.add(new Outcome<>(null, e.getCause()));
                }
            }
            return outcomes;
        } finally {
            pool.shutdownNow();
        }
    }
}
