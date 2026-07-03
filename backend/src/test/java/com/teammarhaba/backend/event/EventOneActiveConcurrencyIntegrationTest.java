package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

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
 * The concurrency guard for "one active event at a time" (TM-413) under a race across two
 * <em>different</em> events (TM-423). The per-event {@code SELECT ... FOR UPDATE} lock (TM-393)
 * serialises writes to a single event, but two GOING-landings by the <b>same user</b> on
 * <b>different</b> events lock different {@code events} rows and never mutually exclude — so without a
 * per-user lock both pass the non-locking {@code guardOneActiveEvent} read and the user ends up GOING
 * to two events. The fix takes a {@code SELECT ... FOR UPDATE} on the caller's {@code users} row at
 * the top of {@link EventRsvpService#rsvp}/{@link EventRsvpService#claim}, so a single user's
 * GOING-landings serialise globally: the first to commit wins, the second sees the committed GOING and
 * is refused with the one-active {@code 409}.
 *
 * <p>Drives the real {@code @Transactional} service against a real Postgres — each racer runs its own
 * transaction on its own connection, so the row locks are what is actually under test, not mocks.
 * Mirrors the harness of {@link EventRsvpConcurrencyIntegrationTest}; thread budget stays under
 * Hikari's default pool of 10.
 */
class EventOneActiveConcurrencyIntegrationTest extends AbstractIntegrationTest {

    private static final int RACE_TIMEOUT_SECONDS = 60;

    /** Substring of {@link EventRsvpService#activeEventBlock} — the one-active 409 copy. */
    private static final String ONE_ACTIVE = "you can only be going to one event at a time";

    @Autowired
    private EventRsvpService rsvps;

    @Autowired
    private EventRepository events;

    @Autowired
    private EventAttendanceRepository attendance;

    @Autowired
    private UserRepository users;

    @Test
    void oneUserRsvpingTwoDifferentEventsAtOnceLandsGoingToExactlyOne() throws Exception {
        VerifiedUser caller = newCaller("double");
        // Both events have free spots, so only the one-active rule — not capacity — can gate a landing.
        Event first = publishedEvent(5);
        Event second = publishedEvent(5);

        List<Outcome<RsvpResult>> outcomes = race(List.of(
                () -> rsvps.rsvp(caller, first.getId()), () -> rsvps.rsvp(caller, second.getId())));

        // Exactly one RSVP lands GOING; the other is refused with the one-active 409 (which names the
        // blocker). Without the per-user lock BOTH would land GOING — the bug this closes.
        assertThat(goingLandings(outcomes))
                .as("exactly one of two concurrent GOING RSVPs on different events may land")
                .isEqualTo(1);
        assertThat(refusals(outcomes))
                .singleElement()
                .satisfies(err -> assertThat(err).isInstanceOf(ConflictException.class).hasMessageContaining(ONE_ACTIVE));
        assertThat(going(first) + going(second))
                .as("the user holds a GOING to exactly one of the two events, never both")
                .isEqualTo(1);
    }

    @Test
    void aClaimAndAFreshRsvpOnDifferentEventsCannotBothLandGoing() throws Exception {
        VerifiedUser caller = newCaller("claimer");
        // Event A: the caller is WAITLISTED with a freed spot to claim — a GOING-landing via claim().
        Event withOpenSpot = publishedEvent(1);
        VerifiedUser holder = newCaller("holder");
        rsvps.rsvp(holder, withOpenSpot.getId()); // holder GOING, fills the single spot
        rsvps.rsvp(caller, withOpenSpot.getId()); // caller WAITLISTED behind them
        rsvps.cancelRsvp(holder, withOpenSpot.getId()); // one spot free, caller still WAITLISTED
        // Event B: a fresh RSVP that would land GOING (free capacity) — a GOING-landing via rsvp().
        Event freshGoing = publishedEvent(5);

        List<Outcome<RsvpResult>> outcomes = race(List.of(
                () -> rsvps.claim(caller, withOpenSpot.getId()), () -> rsvps.rsvp(caller, freshGoing.getId())));

        // The claim and the fresh RSVP are both GOING-landings for one user on different events, so the
        // one-active rule permits exactly one — whichever wins the per-user lock first.
        assertThat(goingLandings(outcomes))
                .as("a claim and a fresh RSVP on different events cannot both land GOING")
                .isEqualTo(1);
        assertThat(refusals(outcomes))
                .singleElement()
                .satisfies(err -> assertThat(err).isInstanceOf(ConflictException.class).hasMessageContaining(ONE_ACTIVE));
        assertThat(going(withOpenSpot) + going(freshGoing))
                .as("the caller is GOING to exactly one of the two events")
                .isEqualTo(1);
    }

    // ------------------------------------------------------------------ harness & fixtures

    /** One racer's result: exactly one of {@code value} / {@code error} is set. */
    private record Outcome<T>(T value, Throwable error) {}

    /** How many racers landed a GOING result (no error, state GOING). */
    private long goingLandings(List<Outcome<RsvpResult>> outcomes) {
        return outcomes.stream()
                .filter(o -> o.error() == null && o.value().state() == AttendanceState.GOING)
                .count();
    }

    /** The errors thrown by refused racers, in outcome order. */
    private List<Throwable> refusals(List<Outcome<RsvpResult>> outcomes) {
        return outcomes.stream().filter(o -> o.error() != null).map(Outcome::error).toList();
    }

    /**
     * Run every task on its own thread, released together through a barrier so they hit the row locks
     * as one wave. Returns per-task outcomes; asserting who may fail is the test's job.
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
                "One-active concurrency test fixture",
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

    private long going(Event event) {
        return attendance.countByEventIdAndState(event.getId(), AttendanceState.GOING);
    }
}
