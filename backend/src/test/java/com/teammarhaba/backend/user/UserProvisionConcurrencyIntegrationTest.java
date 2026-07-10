package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

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
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The concurrency + read-only guards on just-in-time provisioning (TM-597).
 *
 * <p>{@link UserService#provision} is hit from read-only {@code /me}-surface reads and, on a new user's
 * first-request burst, from many parallel calls at once. Two bugs surfaced (TM-595 e2e): a first-sight
 * INSERT inside a read-only caller transaction threw "cannot execute INSERT in a read-only
 * transaction", and two concurrent first requests double-inserted, tripping {@code users_firebase_uid_key}.
 *
 * <p>Drives the real {@code @Transactional} service against a real Postgres — each racer runs on its
 * own thread and connection, so the unique constraint and the {@code REQUIRES_NEW} writable-transaction
 * boundary are what is actually under test, not mocks. Thread budget stays well under Hikari's default
 * pool of 10 (2 racers, each briefly holding an outer + an inner connection).
 */
class UserProvisionConcurrencyIntegrationTest extends AbstractIntegrationTest {

    private static final int RACE_TIMEOUT_SECONDS = 60;

    @Autowired
    private UserService userService;

    @Autowired
    private UserRepository users;

    @Autowired
    private PlatformTransactionManager txManager;

    /**
     * The core race: a single new uid provisioned by two callers at the exact same moment. Before the
     * fix one racer failed with a {@code users_firebase_uid_key} unique violation; now neither errors,
     * exactly one row is created, and both callers are handed that same row.
     */
    @Test
    void concurrentProvisionOfSameNewUidCreatesExactlyOneRowAndBothCallersGetIt() throws Exception {
        VerifiedUser caller = new VerifiedUser("uid-race-" + UUID.randomUUID(), "race@example.com");

        List<Outcome<User>> outcomes =
                race(List.of(() -> userService.provision(caller), () -> userService.provision(caller)));

        // Neither racer errored — the loser of the insert race recovered by re-reading, not by throwing.
        assertThat(outcomes).allSatisfy(o -> assertThat(o.error())
                .as("provision must never surface the insert race as an error")
                .isNull());
        // Both callers resolved to the *same* single row...
        List<Long> ids = outcomes.stream().map(o -> o.value().getId()).distinct().toList();
        assertThat(ids).as("both concurrent callers get the one shared row").hasSize(1);
        // ...and exactly one row physically exists for the uid (no duplicate slipped through).
        assertThat(users.findByFirebaseUid(caller.uid())).isPresent();
        assertThat(users.findAll().stream().filter(u -> caller.uid().equals(u.getFirebaseUid())))
                .as("exactly one users row exists for the raced uid")
                .hasSize(1);
    }

    /**
     * The read-only-transaction guard: provisioning a brand-new user from inside a read-only
     * transaction (as every {@code /me}-surface read does) must still create the row instead of failing
     * with "cannot execute INSERT in a read-only transaction". The write escapes to its own writable
     * {@code REQUIRES_NEW} transaction, so it commits even though the caller's transaction is read-only.
     */
    @Test
    void provisionInsideAReadOnlyTransactionStillCreatesTheRow() {
        VerifiedUser caller = new VerifiedUser("uid-ro-" + UUID.randomUUID(), "ro@example.com");
        TransactionTemplate readOnlyTx = new TransactionTemplate(txManager);
        readOnlyTx.setReadOnly(true);

        User provisioned = assertThatProvisionSucceeds(readOnlyTx, caller);

        assertThat(provisioned.getId()).isNotNull();
        assertThat(provisioned.getFirebaseUid()).isEqualTo(caller.uid());
        // The row is committed and visible after the read-only outer transaction returns.
        assertThat(users.findByFirebaseUid(caller.uid())).isPresent();
    }

    private User assertThatProvisionSucceeds(TransactionTemplate readOnlyTx, VerifiedUser caller) {
        List<User> holder = new ArrayList<>(1);
        assertThatCode(() -> readOnlyTx.executeWithoutResult(status -> holder.add(userService.provision(caller))))
                .as("provisioning from a read-only transaction must not fail on the write")
                .doesNotThrowAnyException();
        return holder.get(0);
    }

    // ------------------------------------------------------------------ harness

    /** One racer's result: exactly one of {@code value} / {@code error} is set. */
    private record Outcome<T>(T value, Throwable error) {}

    /**
     * Run every task on its own thread, released together through a barrier so they hit provisioning as
     * one wave. Returns per-task outcomes; asserting who may fail is the test's job.
     */
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
