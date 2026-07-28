package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * TM-996 — a soft-deleted attendee's {@code GOING} row must stop consuming a capacity spot, and the
 * spot must free automatically at the query level (no admin action, no reclaim job). This drives the
 * fix end-to-end through the real RSVP service against a live Postgres: the corrected count feeds the
 * full-gate, so once the ghost attendee is tombstoned a fresh caller lands {@code GOING} rather than
 * being wrongly pushed to the waitlist of an "effectively down a seat forever" event.
 *
 * <p>Fail-before/pass-after: on the pre-fix tree {@code countByEventIdAndState} counted the
 * tombstoned row, so {@code goingCount} stayed at 1 (capacity full) and the newcomer landed
 * {@code WAITLISTED} — this test's GOING assertions were RED. After the fix the join through
 * {@code User}'s {@code @SQLRestriction} drops the tombstoned account, the count reads 0, and the
 * newcomer lands {@code GOING} — GREEN.
 */
class EventCapacitySoftDeletedAttendeeIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private EventRsvpService rsvps;

    @Autowired
    private EventRepository events;

    @Autowired
    private EventAttendanceRepository attendance;

    @Autowired
    private UserRepository users;

    @Autowired
    private JdbcTemplate jdbc;

    @Test
    void softDeletingTheOnlyGoingAttendeeFreesTheCapacitySpotForANewRsvp() {
        Event event = publishedEvent(1); // capacity-1: exactly one GOING spot
        VerifiedUser ghost = newCaller("ghost");
        VerifiedUser newcomer = newCaller("newcomer");
        Long ghostId = id(ghost); // snapshot NOW — the User row is hidden once it is tombstoned below

        // The ghost takes the single spot: GOING, event now full.
        assertThat(rsvps.rsvp(ghost, event.getId()).state()).isEqualTo(AttendanceState.GOING);
        assertThat(going(event)).isEqualTo(1);

        // The ghost's account is soft-deleted while still holding the GOING row (the leak scenario).
        jdbc.update("update users set deleted_at = now() where id = ?", ghostId);

        // The row survives (history is truthful — no hard delete)...
        assertThat(attendance.findByEventIdAndUserId(event.getId(), ghostId))
                .as("the tombstoned attendee's row is not deleted")
                .isPresent();
        // ...but goingCount drops to 0: the spot frees automatically at the query level (TM-996).
        assertThat(going(event))
                .as("a soft-deleted GOING attendee no longer counts toward capacity")
                .isZero();

        // The freed spot is RSVP-able: the newcomer lands GOING, not WAITLISTED.
        assertThat(rsvps.rsvp(newcomer, event.getId()).state())
                .as("the freed spot is immediately claimable by a fresh RSVP")
                .isEqualTo(AttendanceState.GOING);
        assertThat(going(event)).isEqualTo(1); // one LIVE going attendee (the ghost no longer counts)
        assertThat(waitlisted(event)).isZero(); // nobody was pushed to the waitlist of a full event
    }

    @Test
    void normalCapacityBehaviourIsUnchangedForLiveAttendees() {
        // Regression guard: with no soft-delete, a capacity-1 event still fills and waitlists exactly
        // as before — the fix must not free spots for live attendees.
        Event event = publishedEvent(1);
        VerifiedUser first = newCaller("first");
        VerifiedUser second = newCaller("second");

        assertThat(rsvps.rsvp(first, event.getId()).state()).isEqualTo(AttendanceState.GOING);
        assertThat(rsvps.rsvp(second, event.getId()).state()).isEqualTo(AttendanceState.WAITLISTED);
        assertThat(going(event)).isEqualTo(1);
        assertThat(waitlisted(event)).isEqualTo(1);
    }

    // ------------------------------------------------------------------ fixtures & helpers

    /** A PUBLISHED event, visible now, starting tomorrow, with the given capacity. */
    private Event publishedEvent(Integer capacity) {
        Instant now = Instant.now();
        User creator = users.save(new User("uid-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"));
        Event event = new Event(
                "Capacity leak fixture " + UUID.randomUUID(),
                "TM-996 regression fixture",
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
        User user = users.save(new User(uid, tag + "-" + UUID.randomUUID() + "@example.com", tag));
        return new VerifiedUser(user.getFirebaseUid(), user.getEmail());
    }

    private long going(Event event) {
        return attendance.countByEventIdAndState(event.getId(), AttendanceState.GOING);
    }

    private long waitlisted(Event event) {
        return attendance.countByEventIdAndState(event.getId(), AttendanceState.WAITLISTED);
    }

    private Long id(VerifiedUser caller) {
        return users.findByFirebaseUid(caller.uid()).orElseThrow().getId();
    }
}
