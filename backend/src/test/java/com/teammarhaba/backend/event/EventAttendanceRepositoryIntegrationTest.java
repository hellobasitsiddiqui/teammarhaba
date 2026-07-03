package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.tuple;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;

/**
 * Verifies the {@code event_attendance} mapping against a real Postgres (Testcontainers) — the
 * pieces the DB owns and an H2/unit test could never prove: the {@code UNIQUE (event_id, user_id)}
 * pair, strict FIFO waitlist ordering by DB-authoritative {@code created_at}, per-state counts, and
 * that attendance rows survive an attendee's account soft-delete (people are resolved through the
 * {@code User} aggregate, which hides tombstoned accounts — never through this table).
 */
class EventAttendanceRepositoryIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private EventAttendanceRepository attendance;

    @Autowired
    private EventRepository events;

    @Autowired
    private UserRepository users;

    @Autowired
    private JdbcTemplate jdbc;

    private Long newUser(String uid) {
        return users.save(new User(uid, uid + "@example.com", uid)).getId();
    }

    private Long newEvent(String heading) {
        Instant now = Instant.now();
        return events.save(new Event(
                        heading,
                        "A friendly meetup.",
                        "Marhaba Cafe, 12 High St",
                        "Europe/London",
                        now.plus(Duration.ofDays(7)),
                        now.minus(Duration.ofHours(1)),
                        now.plus(Duration.ofDays(30)),
                        newUser(heading + "-creator"),
                        now))
                .getId();
    }

    @Test
    void secondJoinOfTheSameUserViolatesTheUniquePair() {
        Long eventId = newEvent("unique-pair");
        Long userId = newUser("unique-pair-attendee");

        attendance.save(new EventAttendance(eventId, userId, AttendanceState.GOING));

        assertThatThrownBy(() -> attendance.save(new EventAttendance(eventId, userId, AttendanceState.WAITLISTED)))
                .isInstanceOf(DataIntegrityViolationException.class);

        // The same user on a different event is fine — the pair is the key, not the user.
        Long otherEvent = newEvent("unique-pair-other");
        attendance.save(new EventAttendance(otherEvent, userId, AttendanceState.GOING));
        assertThat(attendance.findByEventIdAndUserId(otherEvent, userId)).isPresent();
    }

    @Test
    void waitlistComesBackInStrictFifoOrderWithDbAuthoritativeCreatedAt() {
        Long eventId = newEvent("fifo");
        Long first = newUser("fifo-1");
        Long second = newUser("fifo-2");
        Long third = newUser("fifo-3");

        // Each save runs in its own transaction, so each row gets its own DB-side now().
        attendance.save(new EventAttendance(eventId, first, AttendanceState.WAITLISTED));
        attendance.save(new EventAttendance(eventId, second, AttendanceState.WAITLISTED));
        attendance.save(new EventAttendance(eventId, third, AttendanceState.WAITLISTED));

        List<EventAttendance> waitlist = attendance.findWaitlistFifo(eventId);

        assertThat(waitlist).extracting(EventAttendance::getUserId).containsExactly(first, second, third);
        // created_at is DB-set (the entity never supplies it) and non-decreasing down the queue.
        assertThat(waitlist).allSatisfy(a -> assertThat(a.getCreatedAt()).isNotNull());
        assertThat(waitlist).extracting(EventAttendance::getCreatedAt).isSorted();
    }

    @Test
    void promotionKeepsTheOriginalQueuePosition() {
        Long eventId = newEvent("promote");
        Long first = newUser("promote-1");
        Long second = newUser("promote-2");
        attendance.save(new EventAttendance(eventId, first, AttendanceState.WAITLISTED));
        attendance.save(new EventAttendance(eventId, second, AttendanceState.WAITLISTED));

        // A slot frees up: the head of the queue is promoted; the row (and its created_at) is kept.
        EventAttendance head = attendance.findWaitlistFifo(eventId).getFirst();
        Instant joinedAt = head.getCreatedAt();
        head.promote();
        attendance.save(head);

        assertThat(attendance.findWaitlistFifo(eventId))
                .extracting(EventAttendance::getUserId)
                .containsExactly(second);
        EventAttendance promoted = attendance.findByEventIdAndUserId(eventId, first).orElseThrow();
        assertThat(promoted.getState()).isEqualTo(AttendanceState.GOING);
        assertThat(promoted.getCreatedAt()).isEqualTo(joinedAt);
    }

    @Test
    void countsAndTalliesGroupByState() {
        Long eventA = newEvent("tally-a");
        Long eventB = newEvent("tally-b");
        attendance.save(new EventAttendance(eventA, newUser("tally-1"), AttendanceState.GOING));
        attendance.save(new EventAttendance(eventA, newUser("tally-2"), AttendanceState.GOING));
        attendance.save(new EventAttendance(eventA, newUser("tally-3"), AttendanceState.WAITLISTED));
        attendance.save(new EventAttendance(eventB, newUser("tally-4"), AttendanceState.GOING));

        assertThat(attendance.countByEventIdAndState(eventA, AttendanceState.GOING)).isEqualTo(2);
        assertThat(attendance.countByEventIdAndState(eventA, AttendanceState.WAITLISTED)).isEqualTo(1);
        assertThat(attendance.countByEventIdAndState(eventB, AttendanceState.WAITLISTED)).isZero();

        assertThat(attendance.tallyByEventIds(List.of(eventA, eventB)))
                .extracting(t -> t.getEventId(), t -> t.getState(), t -> t.getTotal())
                .containsExactlyInAnyOrder(
                        tuple(eventA, AttendanceState.GOING, 2L),
                        tuple(eventA, AttendanceState.WAITLISTED, 1L),
                        tuple(eventB, AttendanceState.GOING, 1L));
    }

    @Test
    void attendanceSurvivesAnAttendeeSoftDeleteAndPeopleResolveThroughUser() {
        Long eventId = newEvent("tombstone");
        Long userId = newUser("tombstone-attendee");
        attendance.save(new EventAttendance(eventId, userId, AttendanceState.GOING));

        // Account soft-delete is a tombstone, not a hard DELETE — the FK never fires.
        jdbc.update("update users set deleted_at = now() where id = ?", userId);

        // The attendance row survives (history/counts stay truthful)...
        assertThat(attendance.findByEventIdAndUserId(eventId, userId)).isPresent();
        assertThat(attendance.countByEventIdAndState(eventId, AttendanceState.GOING)).isEqualTo(1);
        // ...but the person no longer resolves through the User aggregate — which is exactly why
        // callers must resolve people through UserRepository, never through this child table.
        assertThat(users.findById(userId)).isEmpty();
    }

    @Test
    @Transactional // @Modifying delete needs a transaction; the leave API's service provides one.
    void leaveIsOwnerScopedAndIdempotent() {
        Long eventId = newEvent("leave");
        Long leaver = newUser("leave-1");
        Long stayer = newUser("leave-2");
        attendance.save(new EventAttendance(eventId, leaver, AttendanceState.GOING));
        attendance.save(new EventAttendance(eventId, stayer, AttendanceState.GOING));

        assertThat(attendance.deleteByEventIdAndUserId(eventId, leaver)).isEqualTo(1);
        assertThat(attendance.deleteByEventIdAndUserId(eventId, leaver)).isZero(); // already gone — no-op
        assertThat(attendance.findByEventIdAndUserId(eventId, leaver)).isEmpty();
        assertThat(attendance.findByEventIdAndUserId(eventId, stayer)).isPresent();
    }
}
