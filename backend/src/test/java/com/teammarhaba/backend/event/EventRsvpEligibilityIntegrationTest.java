package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.ConflictException;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * Service-level enforcement of TM-413's two RSVP-eligibility guards against a real Postgres, driving
 * {@link EventRsvpService} directly (each command in its own transaction, so the guards run exactly
 * as they would in production). The precise boundary + fallback arithmetic is pinned by the fast
 * {@link BookingCutoffPolicyTest}; this test proves the guards actually gate the RSVP / waitlist-join
 * / claim commands and return the honest 409s.
 *
 * <p><b>Rule 1 — booking cutoff:</b> a join is refused once {@code now >= start − cutoffHours}
 * (default 1h), for a would-be GOING RSVP, a would-be waitlist-join and a claim alike; a per-event
 * override flows through the resolver.
 *
 * <p><b>Rule 2 — one active event at a time:</b> a second GOING RSVP (or a claim) is blocked with a
 * 409 naming the event the caller is still going to; waitlisting a second event is allowed; and
 * leaving the first, it finishing, or it being cancelled all free the caller.
 */
class EventRsvpEligibilityIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private EventRsvpService rsvps;

    @Autowired
    private EventRepository events;

    @Autowired
    private EventAttendanceRepository attendance;

    @Autowired
    private UserRepository users;

    // ================================================================ Rule 1 — booking cutoff

    @Test
    void rsvpAllowedComfortablyOutsideTheCutoffWindow() {
        Event event = futureEvent("Outside cutoff", Duration.ofHours(3), null, null);
        VerifiedUser caller = newCaller("out");

        assertThat(rsvps.rsvp(caller, event.getId()).state()).isEqualTo(AttendanceState.GOING);
    }

    @Test
    void rsvpRejectedInsideTheCutoffWindow() {
        Event event = futureEvent("Inside cutoff", Duration.ofMinutes(30), null, null);
        VerifiedUser caller = newCaller("in");

        assertThatThrownBy(() -> rsvps.rsvp(caller, event.getId()))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRsvpService.BOOKING_CLOSED);
        assertThat(attendance.findByEventIdAndUserId(event.getId(), id(caller))).isEmpty();
    }

    @Test
    void waitlistJoinAlsoRejectedInsideTheCutoffWindow() {
        // A full event inside the cutoff: a fresh RSVP would land WAITLISTED, but Rule 1 refuses even
        // that — waitlist-join is a "join" too.
        Event event = futureEvent("Full inside cutoff", Duration.ofMinutes(30), null, 1);
        seatGoing(event, newCaller("holder")); // fills the single spot directly (event is past cutoff)
        VerifiedUser newcomer = newCaller("late");

        assertThatThrownBy(() -> rsvps.rsvp(newcomer, event.getId()))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRsvpService.BOOKING_CLOSED);
    }

    @Test
    void claimRejectedInsideTheCutoffWindow() {
        Event event = futureEvent("Claim inside cutoff", Duration.ofMinutes(30), null, 1);
        VerifiedUser waiter = newCaller("waiter");
        seatWaitlisted(event, waiter); // waitlisted directly (event is past cutoff)

        assertThatThrownBy(() -> rsvps.claim(waiter, event.getId()))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRsvpService.BOOKING_CLOSED);
    }

    @Test
    void perEventCutoffOverrideWidensTheWindowAndIsEnforced() {
        // Starts in 90 min: open under the 1h app default, but a 2h per-event override closes it.
        Event event = futureEvent("Override cutoff", Duration.ofMinutes(90), null, null);
        event.setBookingCutoffHours(2);
        events.save(event);
        VerifiedUser caller = newCaller("override");

        assertThatThrownBy(() -> rsvps.rsvp(caller, event.getId()))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRsvpService.BOOKING_CLOSED);
    }

    // ================================================================ Rule 2 — one active event

    @Test
    void secondGoingRsvpIsBlockedAndNamesTheActiveEvent() {
        Event active = futureEvent("Rooftop social", Duration.ofDays(2), Duration.ofDays(2).plusHours(3), null);
        Event other = futureEvent("Picnic", Duration.ofDays(3), null, null);
        VerifiedUser caller = newCaller("busy");
        assertThat(rsvps.rsvp(caller, active.getId()).state()).isEqualTo(AttendanceState.GOING);

        assertThatThrownBy(() -> rsvps.rsvp(caller, other.getId()))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRsvpService.activeEventBlock("Rooftop social"));
        assertThat(attendance.findByEventIdAndUserId(other.getId(), id(caller)))
                .as("the blocked RSVP wrote nothing")
                .isEmpty();
    }

    @Test
    void waitlistingASecondEventIsAllowedWhileHoldingAGoingSpot() {
        Event active = futureEvent("Rooftop social", Duration.ofDays(2), Duration.ofDays(2).plusHours(3), null);
        Event full = futureEvent("Sold-out talk", Duration.ofDays(2), null, 1);
        rsvps.rsvp(newCaller("headliner"), full.getId()); // fills the one spot (future event, allowed)
        VerifiedUser caller = newCaller("busy");
        rsvps.rsvp(caller, active.getId()); // GOING to the active event

        // Only GOING blocks — the caller may still queue on a second event.
        RsvpResult result = rsvps.rsvp(caller, full.getId());

        assertThat(result.state()).isEqualTo(AttendanceState.WAITLISTED);
    }

    @Test
    void leavingTheActiveEventFreesTheCallerToJoinAnother() {
        Event active = futureEvent("Rooftop social", Duration.ofDays(2), Duration.ofDays(2).plusHours(3), null);
        Event other = futureEvent("Picnic", Duration.ofDays(3), null, null);
        VerifiedUser caller = newCaller("busy");
        rsvps.rsvp(caller, active.getId());
        assertThatThrownBy(() -> rsvps.rsvp(caller, other.getId())).isInstanceOf(ConflictException.class);

        rsvps.cancelRsvp(caller, active.getId()); // un-RSVP the first …

        assertThat(rsvps.rsvp(caller, other.getId()).state()) // … now the second is allowed
                .isEqualTo(AttendanceState.GOING);
    }

    @Test
    void aFinishedActiveEventNoLongerBlocks() {
        Event active = futureEvent("Rooftop social", Duration.ofDays(2), Duration.ofDays(2).plusHours(3), null);
        Event other = futureEvent("Picnic", Duration.ofDays(3), null, null);
        VerifiedUser caller = newCaller("busy");
        rsvps.rsvp(caller, active.getId());

        // The active event ran and ended in the past — the GOING row remains but no longer commits.
        Instant now = Instant.now();
        active.setStartAt(now.minus(Duration.ofHours(3)));
        active.setEndAt(now.minus(Duration.ofHours(1)));
        events.save(active);

        assertThat(rsvps.rsvp(caller, other.getId()).state()).isEqualTo(AttendanceState.GOING);
    }

    @Test
    void anOpenEndedActiveEventStillBlocksWhileWithinItsRunLength() {
        // TM-404: an open-ended (no endAt) event stays HAPPENING_NOW until startAt + defaultDuration
        // (3h under the test profile). Started 1h ago it is still live, so it must still block a second
        // GOING landing — the old coalesce(endAt, startAt) guard wrongly cleared at startAt for open-ended.
        Event active = futureEvent("Open jam", Duration.ofDays(2), null, null);
        Event other = futureEvent("Picnic", Duration.ofDays(3), null, null);
        VerifiedUser caller = newCaller("busy");
        rsvps.rsvp(caller, active.getId());

        active.setStartAt(Instant.now().minus(Duration.ofHours(1))); // started 1h ago; endAt stays null
        events.save(active);

        assertThatThrownBy(() -> rsvps.rsvp(caller, other.getId()))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRsvpService.activeEventBlock("Open jam"));
    }

    @Test
    void anOpenEndedActiveEventNoLongerBlocksPastItsRunLength() {
        // Once an open-ended event is past startAt + defaultDuration (3h) it is finished and clears.
        Event active = futureEvent("Open jam", Duration.ofDays(2), null, null);
        Event other = futureEvent("Picnic", Duration.ofDays(3), null, null);
        VerifiedUser caller = newCaller("busy");
        rsvps.rsvp(caller, active.getId());

        active.setStartAt(Instant.now().minus(Duration.ofHours(4))); // started 4h ago (> 3h); endAt null
        events.save(active);

        assertThat(rsvps.rsvp(caller, other.getId()).state()).isEqualTo(AttendanceState.GOING);
    }

    @Test
    void aCancelledActiveEventDoesNotBlock() {
        Event active = futureEvent("Rooftop social", Duration.ofDays(2), Duration.ofDays(2).plusHours(3), null);
        Event other = futureEvent("Picnic", Duration.ofDays(3), null, null);
        VerifiedUser caller = newCaller("busy");
        rsvps.rsvp(caller, active.getId());

        active.cancel(Instant.now()); // the event is called off — no longer a live commitment
        events.save(active);

        assertThat(rsvps.rsvp(caller, other.getId()).state()).isEqualTo(AttendanceState.GOING);
    }

    @Test
    void claimIsBlockedWhileGoingElsewhereThenAllowedOnceFreed() {
        Event active = futureEvent("Rooftop social", Duration.ofDays(2), Duration.ofDays(2).plusHours(3), null);
        Event full = futureEvent("Sold-out talk", Duration.ofDays(2), null, 1);
        VerifiedUser holder = newCaller("holder");
        VerifiedUser caller = newCaller("busy");
        rsvps.rsvp(holder, full.getId()); // holder is GOING, filling the one spot
        rsvps.rsvp(caller, active.getId()); // caller is GOING to the active event
        rsvps.rsvp(caller, full.getId()); // caller waitlists the full event (allowed)
        rsvps.cancelRsvp(holder, full.getId()); // a spot frees on the full event

        // Claiming would land the caller GOING to a *second* event — blocked, naming the first.
        assertThatThrownBy(() -> rsvps.claim(caller, full.getId()))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRsvpService.activeEventBlock("Rooftop social"));

        rsvps.cancelRsvp(caller, active.getId()); // free the caller …

        assertThat(rsvps.claim(caller, full.getId()).state()) // … and the claim now succeeds
                .isEqualTo(AttendanceState.GOING);
    }

    // ================================================================ fixtures

    /**
     * A PUBLISHED event visible now, starting {@code startIn} from now and ending {@code endIn} from
     * now ({@code null} = open-ended), with the given capacity ({@code null} = unlimited).
     */
    private Event futureEvent(String heading, Duration startIn, Duration endIn, Integer capacity) {
        Instant now = Instant.now();
        User creator = users.save(
                new User("uid-creator-" + UUID.randomUUID(), "creator-" + UUID.randomUUID() + "@example.com", "Creator"));
        Instant start = now.plus(startIn);
        Event event = new Event(
                heading,
                "Eligibility fixture",
                "Marhaba Cafe",
                "Europe/London",
                start,
                now.minus(Duration.ofHours(1)), // visible since an hour ago …
                start.plus(Duration.ofDays(7)), // … until well after it starts
                creator.getId(),
                now);
        if (endIn != null) {
            event.setEndAt(now.plus(endIn));
        }
        event.setCapacity(capacity);
        // Genuinely free (£0): this suite is about the eligibility guards (cutoff / one-active /
        // age), not payment. With the default £5 price, a caller's FIRST direct join now CONSUMES
        // their first-event credit (TM-629), so their SECOND event here would resolve PAY and the
        // paid-join gate's 402 would fire before the guard under test.
        event.setPricePence(0);
        return events.save(event);
    }

    private VerifiedUser newCaller(String tag) {
        String uid = "uid-" + tag + "-" + UUID.randomUUID();
        User user = users.save(new User(uid, tag + "-" + UUID.randomUUID() + "@example.com", tag));
        return new VerifiedUser(user.getFirebaseUid(), user.getEmail());
    }

    /** Seat a caller directly as GOING — used when the event is already past its cutoff. */
    private void seatGoing(Event event, VerifiedUser caller) {
        attendance.save(new EventAttendance(event.getId(), id(caller), AttendanceState.GOING));
    }

    /** Seat a caller directly as WAITLISTED — used when the event is already past its cutoff. */
    private void seatWaitlisted(Event event, VerifiedUser caller) {
        attendance.save(new EventAttendance(event.getId(), id(caller), AttendanceState.WAITLISTED));
    }

    private Long id(VerifiedUser caller) {
        return users.findByFirebaseUid(caller.uid()).orElseThrow().getId();
    }
}
