package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
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
 * Oversell-safety of the admin force-add (TM-592) under the SAME {@code SELECT … FOR UPDATE} lock the
 * RSVP verbs take: a default (non-override) force-add races several concurrent member RSVPs for the one
 * free spot on a capacity-1 event. Because {@link EventRosterAdminService#forceAddAttendee} and
 * {@link EventRsvpService#rsvp} both serialise on the event row, exactly ONE of them may land GOING —
 * the admin op can never race a member into an oversell. Straight at the {@code @Transactional}
 * services against a real Postgres, so the lock itself is under test, not a mock.
 */
class EventRosterForceAddConcurrencyIntegrationTest extends AbstractIntegrationTest {

    private static final int RACE_TIMEOUT_SECONDS = 60;

    @Autowired
    private EventRosterAdminService roster;

    @Autowired
    private EventRsvpService rsvps;

    @Autowired
    private EventRepository events;

    @Autowired
    private EventAttendanceRepository attendance;

    @Autowired
    private UserRepository users;

    @Test
    void defaultForceAddRacingConcurrentRsvpsNeverOversellsTheSingleSpot() throws Exception {
        Event event = publishedEvent(1);
        VerifiedUser adminCaller = newCaller("admin");

        // Five members racing an RSVP for the one spot, plus the admin racing a default force-add of a
        // sixth member. At most one may land GOING.
        List<VerifiedUser> members = newCallers(5);
        long forceAddTarget = idOf(newCaller("force-target"));

        List<Callable<AttendanceState>> moves = new ArrayList<>();
        for (VerifiedUser m : members) {
            moves.add(() -> rsvps.rsvp(m, event.getId()).state());
        }
        moves.add(() -> {
            try {
                return roster.forceAddAttendee(adminCaller, event.getId(), forceAddTarget, false).state();
            } catch (RuntimeException full) {
                return null; // 409 EVENT_FULL when the spot went to a racer — the expected loss outcome
            }
        });

        List<AttendanceState> landed = race(moves);

        long going = landed.stream().filter(s -> s == AttendanceState.GOING).count();
        assertThat(going).as("exactly one of the racers may land GOING on a capacity-1 event").isEqualTo(1);
        assertThat(attendance.countByEventIdAndState(event.getId(), AttendanceState.GOING))
                .as("GOING never exceeds capacity — no oversell across the admin/member race")
                .isEqualTo(1);
    }

    // ------------------------------------------------------------------ fixtures + race harness

    private Event publishedEvent(Integer capacity) {
        Instant now = Instant.now();
        User creator =
                users.save(new User("uid-fa-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"));
        Event event = new Event(
                "ForceAdd-race " + UUID.randomUUID(),
                "Force-add oversell race fixture",
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
        String uid = "uid-fa-" + tag + "-" + UUID.randomUUID();
        User user = users.save(new User(uid, tag + "-" + UUID.randomUUID() + "@example.com", tag));
        return new VerifiedUser(user.getFirebaseUid(), user.getEmail());
    }

    private List<VerifiedUser> newCallers(int n) {
        List<VerifiedUser> list = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            list.add(newCaller("racer-" + i));
        }
        return list;
    }

    private long idOf(VerifiedUser caller) {
        return users.findByFirebaseUid(caller.uid()).orElseThrow().getId();
    }

    private <T> List<T> race(List<Callable<T>> callables) throws Exception {
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
            List<T> results = new ArrayList<>();
            for (Future<T> future : futures) {
                try {
                    results.add(future.get(RACE_TIMEOUT_SECONDS, TimeUnit.SECONDS));
                } catch (ExecutionException e) {
                    results.add(null); // a losing racer (409) — counted as "did not land GOING"
                }
            }
            return results;
        } finally {
            pool.shutdownNow();
        }
    }
}
