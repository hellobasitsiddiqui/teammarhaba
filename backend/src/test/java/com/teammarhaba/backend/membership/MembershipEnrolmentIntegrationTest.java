package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.UserRepository;
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
 * The read-only-transaction + concurrency guards on just-in-time membership enrolment (TM-474), built
 * on the exact TM-597 pattern proven for account provisioning
 * ({@link com.teammarhaba.backend.user.UserProvisionConcurrencyIntegrationTest}).
 *
 * <p>{@link MembershipService#getOrEnrol} is hit from the read-only {@code GET /me/membership} read and,
 * on a new user's first-request burst, from many parallel calls at once. Two failure modes must be
 * ruled out: a first-sight INSERT inside a read-only caller transaction throwing "cannot execute INSERT
 * in a read-only transaction", and two concurrent first requests double-inserting and tripping
 * {@code membership_user_id_key}. Both are handled by delegating the write to
 * {@link MembershipProvisioner} in its own {@code REQUIRES_NEW} writable transaction.
 *
 * <p>Drives the real {@code @Transactional} service against a real Postgres — each racer runs on its own
 * thread + connection, so the unique constraint and the {@code REQUIRES_NEW} boundary are what is
 * actually under test, not mocks. Thread budget stays well under Hikari's default pool of 10.
 */
class MembershipEnrolmentIntegrationTest extends AbstractIntegrationTest {

    private static final int RACE_TIMEOUT_SECONDS = 60;

    @Autowired
    private MembershipService membershipService;

    @Autowired
    private MembershipRepository memberships;

    @Autowired
    private UserRepository users;

    @Autowired
    private PlatformTransactionManager txManager;

    /**
     * The read-only-transaction guard: enrolling a brand-new membership from inside a read-only
     * transaction (as {@code GET /me/membership} does) must still create the row instead of failing with
     * "cannot execute INSERT in a read-only transaction". The write escapes to its own writable
     * {@code REQUIRES_NEW} transaction, so it commits even though the caller's transaction is read-only.
     */
    @Test
    void enrolInsideAReadOnlyTransactionStillCreatesTheRow() {
        VerifiedUser caller = new VerifiedUser("uid-mem-ro-" + UUID.randomUUID(), "ro@example.com");
        TransactionTemplate readOnlyTx = new TransactionTemplate(txManager);
        readOnlyTx.setReadOnly(true);

        Membership enrolled = enrolInReadOnlyTx(readOnlyTx, caller);

        assertThat(enrolled.getId()).isNotNull();
        assertThat(enrolled.getTier()).isEqualTo(MembershipTier.PAY_PER_EVENT);
        assertThat(enrolled.isFirstEventCreditUsed()).isFalse();
        // The row is committed and visible after the read-only outer transaction returns.
        Long userId = users.findByFirebaseUid(caller.uid()).orElseThrow().getId();
        assertThat(memberships.findByUserId(userId)).isPresent();
    }

    /**
     * The core enrolment race: a single new account enrolled by two callers at the exact same moment.
     * Neither errors, exactly one membership row is created, and both callers resolve to it.
     */
    @Test
    void concurrentEnrolOfSameNewUserCreatesExactlyOneRowAndBothCallersGetIt() throws Exception {
        VerifiedUser caller = new VerifiedUser("uid-mem-race-" + UUID.randomUUID(), "race@example.com");

        List<Outcome<Membership>> outcomes = race(
                List.of(() -> membershipService.getOrEnrol(caller), () -> membershipService.getOrEnrol(caller)));

        // Neither racer errored — the loser of the insert race recovered by re-reading, not by throwing.
        assertThat(outcomes).allSatisfy(o -> assertThat(o.error())
                .as("enrol must never surface the insert race as an error")
                .isNull());
        // Both callers resolved to the *same* single membership row...
        List<Long> ids = outcomes.stream().map(o -> o.value().getId()).distinct().toList();
        assertThat(ids).as("both concurrent callers get the one shared row").hasSize(1);
        // ...and exactly one row physically exists for the account.
        Long userId = users.findByFirebaseUid(caller.uid()).orElseThrow().getId();
        assertThat(memberships.findAll().stream().filter(m -> m.getUserId().equals(userId)))
                .as("exactly one membership row exists for the enrolled account")
                .hasSize(1);
    }

    private Membership enrolInReadOnlyTx(TransactionTemplate readOnlyTx, VerifiedUser caller) {
        List<Membership> holder = new ArrayList<>(1);
        assertThatCode(() -> readOnlyTx.executeWithoutResult(status -> holder.add(membershipService.getOrEnrol(caller))))
                .as("enrolling from a read-only transaction must not fail on the write")
                .doesNotThrowAnyException();
        return holder.get(0);
    }

    // ------------------------------------------------------------------ harness

    /** One racer's result: exactly one of {@code value} / {@code error} is set. */
    private record Outcome<T>(T value, Throwable error) {}

    /**
     * Run every task on its own thread, released together through a barrier so they hit enrolment as one
     * wave. Returns per-task outcomes; asserting who may fail is the test's job.
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
