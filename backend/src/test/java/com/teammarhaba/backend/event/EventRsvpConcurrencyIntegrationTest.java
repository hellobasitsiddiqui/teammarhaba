package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.ConflictException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
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
 * The concurrency-safety heart of TM-393: RSVP and claim races against a real Postgres, straight
 * at the {@code @Transactional} service (each task runs its own transaction on its own
 * connection), so the {@code SELECT ... FOR UPDATE} locking discipline is what is actually under
 * test — not mocks.
 *
 * <p>Covers the ticket's named invariants: <b>no oversell</b> on simultaneous RSVPs and
 * simultaneous claims, <b>first-claim-wins</b> (including claim-vs-fresh-RSVP races), <b>FIFO
 * waitlist order preserved</b> through leave/rejoin/claim, and the offer-cascade policy itself —
 * a freed spot never auto-promotes, and the claim that fills the last spot voids the remaining
 * live offers (the cascade-stop signal) while a partial fill leaves them intact.
 *
 * <p>Thread budget stays under Hikari's default pool of 10 — every racer parks on the event row
 * lock while holding a connection.
 */
class EventRsvpConcurrencyIntegrationTest extends AbstractIntegrationTest {

    private static final int RACE_TIMEOUT_SECONDS = 60;

    @Autowired
    private EventRsvpService rsvps;

    @Autowired
    private EventRepository events;

    @Autowired
    private EventAttendanceRepository attendance;

    @Autowired
    private UserRepository users;

    // ------------------------------------------------------------------ no-oversell races

    @Test
    void simultaneousRsvpsNeverOversellCapacity() throws Exception {
        Event event = publishedEvent(3);
        List<VerifiedUser> racers = newCallers(8);

        List<Outcome<RsvpResult>> outcomes = race(racers.stream()
                .map(who -> (Callable<RsvpResult>) () -> rsvps.rsvp(who, event.getId()))
                .toList());

        assertThat(outcomes).allMatch(o -> o.error() == null, "every RSVP should succeed (GOING or WAITLISTED)");
        assertThat(outcomes.stream()
                        .filter(o -> o.value().state() == AttendanceState.GOING)
                        .count())
                .as("exactly capacity callers may land GOING")
                .isEqualTo(3);
        assertThat(going(event)).isEqualTo(3);
        assertThat(waitlisted(event)).isEqualTo(5);
    }

    @Test
    void simultaneousClaimsCannotOversell_onlyTheFirstClaimerWins() throws Exception {
        Event event = publishedEvent(2);
        VerifiedUser a = newCaller("a");
        VerifiedUser b = newCaller("b");
        List<VerifiedUser> queued = newCallers(4);
        rsvpAll(event, a, b); // fills capacity
        rsvpAll(event, queued.toArray(VerifiedUser[]::new)); // all four land WAITLISTED
        rsvps.cancelRsvp(a, event.getId()); // frees exactly one spot — and promotes nobody

        List<Outcome<RsvpResult>> outcomes = race(queued.stream()
                .map(who -> (Callable<RsvpResult>) () -> rsvps.claim(who, event.getId()))
                .toList());

        List<Outcome<RsvpResult>> wins =
                outcomes.stream().filter(o -> o.error() == null).toList();
        assertThat(wins).as("exactly one concurrent claim may win the single free spot").hasSize(1);
        assertThat(wins.get(0).value().state()).isEqualTo(AttendanceState.GOING);
        assertThat(outcomes.stream().filter(o -> o.error() != null))
                .hasSize(3)
                .allSatisfy(o -> assertThat(o.error())
                        .isInstanceOf(ConflictException.class)
                        .hasMessage(EventRsvpService.SPOT_ALREADY_TAKEN));
        assertThat(going(event)).as("GOING can never exceed capacity").isEqualTo(2);
        assertThat(waitlisted(event)).isEqualTo(3);
    }

    @Test
    void claimVersusFreshRsvpRaceStaysCapacitySafeAndWaitlistFair() throws Exception {
        Event event = publishedEvent(2);
        VerifiedUser a = newCaller("a");
        VerifiedUser b = newCaller("b");
        VerifiedUser queuedC = newCaller("c");
        VerifiedUser newcomerX = newCaller("x");
        rsvpAll(event, a, b);
        rsvpAll(event, queuedC); // WAITLISTED
        rsvps.cancelRsvp(a, event.getId()); // one spot free, waitlist non-empty

        List<Callable<RsvpResult>> moves = List.of(
                () -> rsvps.claim(queuedC, event.getId()), () -> rsvps.rsvp(newcomerX, event.getId()));
        List<Outcome<RsvpResult>> outcomes = race(moves);

        // Whichever order the race resolves in, the result is deterministic: the freed spot belongs
        // to the waitlist (the claimer), and the fresh RSVP queues behind — never an oversell.
        assertThat(outcomes).allMatch(o -> o.error() == null);
        assertThat(stateOf(event, queuedC)).isEqualTo(AttendanceState.GOING);
        assertThat(stateOf(event, newcomerX)).isEqualTo(AttendanceState.WAITLISTED);
        assertThat(going(event)).isEqualTo(2);
        assertThat(waitlisted(event)).isEqualTo(1);
    }

    // ------------------------------------------------------------------ policy: no auto-promotion

    @Test
    void freeingAGoingSpotPromotesNobody() {
        Event event = publishedEvent(1);
        VerifiedUser a = newCaller("a");
        VerifiedUser w1 = newCaller("w1");
        VerifiedUser w2 = newCaller("w2");
        rsvpAll(event, a, w1, w2);

        rsvps.cancelRsvp(a, event.getId());

        // The owner policy: the freed spot is only *recorded* (derived free-spot count goes
        // positive) — waitlisted members stay WAITLISTED until one of them claims.
        assertThat(going(event)).isZero();
        assertThat(stateOf(event, w1)).isEqualTo(AttendanceState.WAITLISTED);
        assertThat(stateOf(event, w2)).isEqualTo(AttendanceState.WAITLISTED);
    }

    @Test
    void anyWaitlistedMemberMayClaim_firstComeWinsSequentiallyToo() {
        Event event = publishedEvent(1);
        VerifiedUser a = newCaller("a");
        VerifiedUser w1 = newCaller("w1");
        VerifiedUser w2 = newCaller("w2");
        rsvpAll(event, a, w1, w2);
        rsvps.cancelRsvp(a, event.getId());

        // W2 is not the FIFO head — notification order is FIFO (TM-397), but the spot goes to the
        // first authenticated claimer, whoever that is.
        assertThat(rsvps.claim(w2, event.getId()).state()).isEqualTo(AttendanceState.GOING);
        assertThatThrownBy(() -> rsvps.claim(w1, event.getId()))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRsvpService.SPOT_ALREADY_TAKEN);
        assertThat(stateOf(event, w1)).as("the loser keeps their queue place").isEqualTo(AttendanceState.WAITLISTED);
    }

    @Test
    void claimIsRefusedWithoutAWaitlistEntryAndIdempotentOnceGoing() {
        Event event = publishedEvent(2);
        VerifiedUser a = newCaller("a");
        VerifiedUser stranger = newCaller("stranger");
        rsvpAll(event, a); // GOING

        assertThatThrownBy(() -> rsvps.claim(stranger, event.getId()))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRsvpService.NOT_ON_WAITLIST);
        // A GOING member double-tapping claim keeps their spot — no error, no state change.
        assertThat(rsvps.claim(a, event.getId()).state()).isEqualTo(AttendanceState.GOING);
        assertThat(going(event)).isEqualTo(1);
    }

    // ------------------------------------------------------------------ FIFO order

    @Test
    void waitlistFifoOrderSurvivesLeaveRejoinAndClaim() {
        Event event = publishedEvent(1);
        VerifiedUser a = newCaller("a");
        VerifiedUser w1 = newCaller("w1");
        VerifiedUser w2 = newCaller("w2");
        VerifiedUser w3 = newCaller("w3");
        rsvpAll(event, a, w1, w2, w3);
        assertThat(fifo(event)).containsExactly(id(w1), id(w2), id(w3));

        rsvps.cancelRsvp(w2, event.getId()); // leaving deletes the row …
        assertThat(fifo(event)).containsExactly(id(w1), id(w3));
        rsvpAll(event, w2); // … so a rejoin re-inserts at the BACK of the queue
        assertThat(fifo(event)).containsExactly(id(w1), id(w3), id(w2));

        rsvps.cancelRsvp(a, event.getId());
        rsvps.claim(w3, event.getId()); // a claim removes exactly the claimer …
        assertThat(fifo(event)).as("… and the relative order of everyone else is untouched")
                .containsExactly(id(w1), id(w2));
    }

    @Test
    void rsvpLandsWaitlistedWhileAWaitlistExistsEvenIfASpotIsFree() {
        Event event = publishedEvent(2);
        VerifiedUser a = newCaller("a");
        VerifiedUser b = newCaller("b");
        VerifiedUser w1 = newCaller("w1");
        VerifiedUser newcomer = newCaller("x");
        rsvpAll(event, a, b, w1);
        rsvps.cancelRsvp(a, event.getId()); // free spot exists, W1 still queued

        RsvpResult result = rsvps.rsvp(newcomer, event.getId());

        // Freed spots belong to the offer cascade — a newcomer may not jump the queue.
        assertThat(result.state()).isEqualTo(AttendanceState.WAITLISTED);
        assertThat(fifo(event)).containsExactly(id(w1), id(newcomer));
        assertThat(going(event)).isEqualTo(1);
    }

    // ------------------------------------------------------------------ offer bookkeeping

    @Test
    void claimFillingTheLastSpotVoidsAllRemainingLiveOffers() {
        Event event = publishedEvent(1);
        VerifiedUser a = newCaller("a");
        VerifiedUser w1 = newCaller("w1");
        VerifiedUser w2 = newCaller("w2");
        VerifiedUser w3 = newCaller("w3");
        rsvpAll(event, a, w1, w2, w3);
        rsvps.cancelRsvp(a, event.getId());
        stampOffer(event, w1); // simulate TM-397's cascade walking the FIFO list …
        stampOffer(event, w2); // … two members notified so far, W3 not yet

        rsvps.claim(w1, event.getId()); // fills the only free spot

        assertThat(offerStamp(event, w1)).as("the claimant's entry closed — stamp cleared").isNull();
        assertThat(offerStamp(event, w2))
                .as("cascade-stop: the other live offer is voided the moment the spot fills")
                .isNull();
        assertThat(offerStamp(event, w3)).isNull();
        assertThat(stateOf(event, w2)).isEqualTo(AttendanceState.WAITLISTED);
        assertThat(stateOf(event, w3)).isEqualTo(AttendanceState.WAITLISTED);
    }

    @Test
    void claimLeavingSpotsFreeKeepsTheOtherLiveOffersIntact() {
        Event event = publishedEvent(2);
        VerifiedUser a = newCaller("a");
        VerifiedUser b = newCaller("b");
        VerifiedUser w1 = newCaller("w1");
        VerifiedUser w2 = newCaller("w2");
        VerifiedUser w3 = newCaller("w3");
        rsvpAll(event, a, b, w1, w2, w3);
        rsvps.cancelRsvp(a, event.getId());
        rsvps.cancelRsvp(b, event.getId()); // two spots free
        stampOffer(event, w1);
        stampOffer(event, w2);
        stampOffer(event, w3);

        rsvps.claim(w1, event.getId()); // one spot still free afterwards — the cascade continues

        assertThat(offerStamp(event, w1)).isNull();
        assertThat(offerStamp(event, w2)).as("cascade still running — offer stays live").isNotNull();
        assertThat(offerStamp(event, w3)).isNotNull();
        assertThat(going(event)).isEqualTo(1);
    }

    // ------------------------------------------------------------------ harness & fixtures

    /** One racer's result: exactly one of {@code value} / {@code error} is set. */
    private record Outcome<T>(T value, Throwable error) {}

    /**
     * Run every task on its own thread, released together through a barrier so they hit the event
     * lock as one wave. Returns per-task outcomes; assertion of who may fail is the test's job.
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

    /** A PUBLISHED event, visible now, starting tomorrow, with the given capacity. */
    private Event publishedEvent(Integer capacity) {
        Instant now = Instant.now();
        User creator = users.save(new User("uid-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"));
        Event event = new Event(
                "Race night " + UUID.randomUUID(),
                "Concurrency test fixture",
                "Marhaba Cafe",
                "Europe/London",
                now.plus(1, ChronoUnit.DAYS),
                now.minus(1, ChronoUnit.HOURS),
                now.plus(7, ChronoUnit.DAYS),
                creator.getId(),
                now);
        event.setCapacity(capacity);
        return events.save(event);
    }

    private VerifiedUser newCaller(String tag) {
        String uid = "uid-" + tag + "-" + UUID.randomUUID();
        User user = users.save(new User(uid, tag + "@example.com", tag));
        return new VerifiedUser(user.getFirebaseUid(), user.getEmail());
    }

    private List<VerifiedUser> newCallers(int n) {
        List<VerifiedUser> callers = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            callers.add(newCaller("racer" + i));
        }
        return callers;
    }

    /** RSVP each caller in the given order (sequential — deterministic FIFO positions). */
    private void rsvpAll(Event event, VerifiedUser... callers) {
        for (VerifiedUser caller : callers) {
            rsvps.rsvp(caller, event.getId());
        }
    }

    private long going(Event event) {
        return attendance.countByEventIdAndState(event.getId(), AttendanceState.GOING);
    }

    private long waitlisted(Event event) {
        return attendance.countByEventIdAndState(event.getId(), AttendanceState.WAITLISTED);
    }

    private AttendanceState stateOf(Event event, VerifiedUser caller) {
        return attendance
                .findByEventIdAndUserId(event.getId(), id(caller))
                .orElseThrow()
                .getState();
    }

    private List<Long> fifo(Event event) {
        return attendance.findWaitlistFifo(event.getId()).stream()
                .map(EventAttendance::getUserId)
                .toList();
    }

    private Long id(VerifiedUser caller) {
        return users.findByFirebaseUid(caller.uid()).orElseThrow().getId();
    }

    /** Simulate TM-397's cascade notifying this waitlisted member (stamps the live offer). */
    private void stampOffer(Event event, VerifiedUser caller) {
        EventAttendance row =
                attendance.findByEventIdAndUserId(event.getId(), id(caller)).orElseThrow();
        row.recordOffer(Instant.now());
        attendance.save(row);
    }

    private Instant offerStamp(Event event, VerifiedUser caller) {
        return attendance
                .findByEventIdAndUserId(event.getId(), id(caller))
                .orElseThrow()
                .getOfferNotifiedAt();
    }
}
