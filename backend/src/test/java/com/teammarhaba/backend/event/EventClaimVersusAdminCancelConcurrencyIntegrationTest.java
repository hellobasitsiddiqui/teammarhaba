package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.ResourceNotFoundException;
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
 * The claim-versus-admin-cancel race on ONE event (TM-738 P1,
 * {@code concurrentClaimAndAdminCancelOnSameEvent}): a waitlisted member claiming a freed spot at the
 * same moment an admin calls the event off. Both writes contend on the same {@code events} row lock —
 * {@link EventRsvpService#claim} takes {@code SELECT … FOR UPDATE} and {@link EventAdminService#cancel}
 * writes the status on the same row — so they serialise, and the outcome is one of exactly two
 * deterministic-per-run results, never a torn state:
 *
 * <ul>
 *   <li><b>claim commits first</b> → the member lands {@code GOING}; the cancel then flips the event
 *       to {@code CANCELLED} but keeps the row (cancel ≠ delete), so the newly-GOING member's
 *       attendance history survives.</li>
 *   <li><b>cancel commits first</b> → the event is {@code CANCELLED}, i.e. no longer visible, so the
 *       claim re-reads a hidden event and is refused with a {@code 404}
 *       ({@link ResourceNotFoundException}); the member stays {@code WAITLISTED}.</li>
 * </ul>
 *
 * <p>Either way there is never an oversell, never a claim into a cancelled event, and the event
 * always ends {@code CANCELLED}. Characterization only (adds no source). Drives the real
 * {@code @Transactional} services against a real Postgres — each task runs its own transaction on its
 * own connection, so the row lock is what is under test, not mocks. Harness mirrors
 * {@code EventRsvpConcurrencyIntegrationTest} / {@code EventOneActiveConcurrencyIntegrationTest};
 * thread budget stays under Hikari's default pool of 10.
 */
class EventClaimVersusAdminCancelConcurrencyIntegrationTest extends AbstractIntegrationTest {

    private static final int RACE_TIMEOUT_SECONDS = 60;

    @Autowired
    private EventRsvpService rsvps;

    @Autowired
    private EventAdminService admin;

    @Autowired
    private EventRepository events;

    @Autowired
    private EventAttendanceRepository attendance;

    @Autowired
    private UserRepository users;

    @Test
    void concurrentClaimAndAdminCancelOnSameEventLeaveNoTornStateAndTheEventEndsCancelled() throws Exception {
        // Run the race several times: thread scheduling decides which write wins each run, so repeating
        // exercises BOTH deterministic outcomes over the suite while every single run stays consistent.
        for (int attempt = 0; attempt < 6; attempt++) {
            runOneRace();
        }
    }

    private void runOneRace() throws Exception {
        // Capacity 1: holder fills it, queued waits, then holder leaves — one free spot for the claim.
        Event event = publishedEvent(1);
        VerifiedUser holder = newCaller("holder");
        VerifiedUser queued = newCaller("queued");
        VerifiedUser adminCaller = newCaller("admin");
        rsvps.rsvp(holder, event.getId()); // GOING, fills the spot
        rsvps.rsvp(queued, event.getId()); // WAITLISTED
        rsvps.cancelRsvp(holder, event.getId()); // frees exactly one spot (promotes nobody)
        stampOffer(event, queued); // TM-397 offered them the spot to claim

        List<Outcome<?>> outcomes = race(List.of(
                () -> rsvps.claim(queued, event.getId()), () -> {
                    admin.cancel(adminCaller, event.getId());
                    return null;
                }));

        Outcome<?> claimOutcome = outcomes.get(0);
        Event finalEvent = events.findById(event.getId()).orElseThrow();
        AttendanceState queuedState = stateOf(event, queued);
        long going = going(event);

        if (claimOutcome.error() == null) {
            // claim won the lock: the member is GOING (their history survives the later cancel), and
            // GOING is exactly one — never an oversell.
            assertThat(((RsvpResult) claimOutcome.value()).state()).isEqualTo(AttendanceState.GOING);
            assertThat(queuedState).isEqualTo(AttendanceState.GOING);
            assertThat(going).isEqualTo(1);
        } else {
            // cancel won the lock first: the event is now hidden, so the claim is refused with a 404 and
            // the member stays WAITLISTED — never promoted into a cancelled event.
            assertThat(claimOutcome.error())
                    .as("a claim losing to the cancel sees a hidden event → 404")
                    .isInstanceOf(ResourceNotFoundException.class);
            assertThat(queuedState).isEqualTo(AttendanceState.WAITLISTED);
            assertThat(going).isZero();
        }
        // In BOTH orderings the admin cancel commits — the event always ends CANCELLED.
        assertThat(finalEvent.getStatus()).isEqualTo(EventStatus.CANCELLED);
    }

    // ------------------------------------------------------------------ harness & fixtures

    /** One racer's result: exactly one of {@code value} / {@code error} is set. */
    private record Outcome<T>(T value, Throwable error) {}

    /** Release every task through a barrier so they hit the event lock as one wave; report per-task outcomes. */
    private List<Outcome<?>> race(List<Callable<?>> callables) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(callables.size());
        try {
            CyclicBarrier startLine = new CyclicBarrier(callables.size());
            List<Future<?>> futures = new ArrayList<>();
            for (Callable<?> task : callables) {
                futures.add(pool.submit(() -> {
                    startLine.await(RACE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                    return task.call();
                }));
            }
            List<Outcome<?>> outcomes = new ArrayList<>();
            for (Future<?> future : futures) {
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

    /** A PUBLISHED, visible-now event starting in two days, with the given capacity. */
    private Event publishedEvent(Integer capacity) {
        Instant now = Instant.now();
        User creator = users.save(new User("uid-cvc-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"));
        Event event = new Event(
                "Claim-vs-cancel " + UUID.randomUUID(),
                "Race fixture",
                "Marhaba Cafe",
                "Europe/London",
                now.plus(2, ChronoUnit.DAYS),
                now.minus(1, ChronoUnit.HOURS),
                now.plus(7, ChronoUnit.DAYS),
                creator.getId(),
                now);
        event.setCapacity(capacity);
        return events.save(event);
    }

    private VerifiedUser newCaller(String tag) {
        String uid = "uid-cvc-" + tag + "-" + UUID.randomUUID();
        User user = users.save(new User(uid, uid + "@example.com", tag));
        return new VerifiedUser(user.getFirebaseUid(), user.getEmail());
    }

    private Long idOf(VerifiedUser caller) {
        return users.findByFirebaseUid(caller.uid()).orElseThrow().getId();
    }

    private long going(Event event) {
        return attendance.countByEventIdAndState(event.getId(), AttendanceState.GOING);
    }

    private AttendanceState stateOf(Event event, VerifiedUser caller) {
        return attendance
                .findByEventIdAndUserId(event.getId(), idOf(caller))
                .orElseThrow()
                .getState();
    }

    /** Stamp a live offer on this member's waitlist row (simulate TM-397's cascade notifying them). */
    private void stampOffer(Event event, VerifiedUser caller) {
        EventAttendance row =
                attendance.findByEventIdAndUserId(event.getId(), idOf(caller)).orElseThrow();
        row.recordOffer(Instant.now());
        attendance.save(row);
    }
}
