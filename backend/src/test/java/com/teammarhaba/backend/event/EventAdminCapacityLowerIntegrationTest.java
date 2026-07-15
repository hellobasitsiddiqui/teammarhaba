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
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * The oversubscribed-after-edit invariant (TM-738 P1,
 * {@code adminEditLoweringCapacityBelowGoingCount_thenRsvpAndClaimStayCapacitySafe}): an admin may
 * lower an event's capacity <em>below</em> its current GOING count — the edit is deliberately not
 * blocked ({@link EventAdminService#update} has no capacity-vs-attendance guard; attendees already
 * committed are never bumped) — and once it has, the RSVP path must stay capacity-safe: with
 * {@code GOING > capacity} there is no free spot, so a fresh RSVP lands {@code WAITLISTED} and a
 * waitlisted member's {@code claim} is refused with the honest {@code 409}. No oversell, no
 * promotion into a capacity the event no longer has.
 *
 * <p>Characterization only (asserts existing behaviour; adds no source). Drives the real
 * {@code @Transactional} {@link EventAdminService} and {@link EventRsvpService} against a real
 * Postgres so the capacity read the RSVP/claim paths make under the {@code SELECT … FOR UPDATE}
 * lock is the merged, edited value — not a mock. Complements
 * {@code EventRsvpConcurrencyIntegrationTest} (which pins oversell safety at a <em>fixed</em>
 * capacity) by pinning it across a mid-life capacity shrink; the cascade-side twin lives in
 * {@code WaitlistCapacityLoweredCascadeIntegrationTest}.
 */
class EventAdminCapacityLowerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private EventAdminService admin;

    @Autowired
    private EventRsvpService rsvps;

    @Autowired
    private EventRepository events;

    @Autowired
    private EventAttendanceRepository attendance;

    @Autowired
    private UserRepository users;

    @Test
    void loweringCapacityBelowGoingCountLeavesNoFreeSpot_soFreshRsvpWaitlistsAndClaimIsRefused() {
        // Capacity 3, filled with three GOING members.
        Event event = publishedEvent(3);
        VerifiedUser a = newCaller("a");
        VerifiedUser b = newCaller("b");
        VerifiedUser c = newCaller("c");
        rsvps.rsvp(a, event.getId());
        rsvps.rsvp(b, event.getId());
        rsvps.rsvp(c, event.getId());
        assertThat(going(event)).isEqualTo(3);

        // A waitlisted member joins behind the full event (they will try to claim after the shrink).
        VerifiedUser queued = newCaller("queued");
        rsvps.rsvp(queued, event.getId());
        assertThat(stateOf(event, queued)).isEqualTo(AttendanceState.WAITLISTED);

        // Admin lowers capacity to 1 — now BELOW the GOING count of 3. The edit succeeds (attendees
        // are never bumped) and the three GOING members keep their spots.
        VerifiedUser adminCaller = newCaller("admin");
        Event edited = admin.update(adminCaller, event.getId(), capacityPatch(1));
        assertThat(edited.getCapacity()).isEqualTo(1);
        assertThat(going(event)).as("committed attendees are not bumped by a capacity drop").isEqualTo(3);

        // A brand-new RSVP now sees no free spot (GOING 3 >= capacity 1) and lands WAITLISTED — never
        // GOING — so the shrink can never be exploited to oversell.
        VerifiedUser newcomer = newCaller("newcomer");
        RsvpResult freshRsvp = rsvps.rsvp(newcomer, event.getId());
        assertThat(freshRsvp.state()).isEqualTo(AttendanceState.WAITLISTED);
        assertThat(going(event)).isEqualTo(3);

        // And the already-waitlisted member's claim is refused: with GOING (3) still at/over the new
        // capacity (1) there is no spot to claim, so it 409s SPOT_ALREADY_TAKEN and they stay queued.
        assertThatThrownBy(() -> rsvps.claim(queued, event.getId()))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRsvpService.SPOT_ALREADY_TAKEN);
        assertThat(stateOf(event, queued)).isEqualTo(AttendanceState.WAITLISTED);
        assertThat(going(event)).as("no oversell after a below-capacity edit").isEqualTo(3);
    }

    @Test
    void afterLoweringCapacityAClaimOnlySucceedsOnceGoingFallsBackWithinTheNewLimit() {
        // Capacity 2, two GOING, one waitlisted with a live offer to claim.
        Event event = publishedEvent(2);
        VerifiedUser a = newCaller("a");
        VerifiedUser b = newCaller("b");
        VerifiedUser queued = newCaller("queued");
        rsvps.rsvp(a, event.getId());
        rsvps.rsvp(b, event.getId());
        rsvps.rsvp(queued, event.getId());
        assertThat(stateOf(event, queued)).isEqualTo(AttendanceState.WAITLISTED);

        // Lower capacity to 1 — below the GOING count of 2. Still no free spot, so a claim is refused.
        VerifiedUser adminCaller = newCaller("admin");
        admin.update(adminCaller, event.getId(), capacityPatch(1));
        assertThatThrownBy(() -> rsvps.claim(queued, event.getId()))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRsvpService.SPOT_ALREADY_TAKEN);

        // One GOING member leaves: GOING falls from 2 to 1, which equals the new capacity — still full,
        // so the claim is STILL refused (a below-limit shrink only becomes claimable once GOING < cap).
        rsvps.cancelRsvp(a, event.getId());
        assertThat(going(event)).isEqualTo(1);
        assertThatThrownBy(() -> rsvps.claim(queued, event.getId()))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRsvpService.SPOT_ALREADY_TAKEN);

        // A second GOING member leaves: GOING (0) is now below capacity (1) — a genuine free spot, so
        // the waitlisted member can finally claim it and land GOING, still within the reduced limit.
        rsvps.cancelRsvp(b, event.getId());
        assertThat(rsvps.claim(queued, event.getId()).state()).isEqualTo(AttendanceState.GOING);
        assertThat(going(event)).as("claim honours the LOWERED capacity, never the original").isEqualTo(1);
    }

    // ------------------------------------------------------------------ fixtures

    /** A capacity-only patch: every other field null (unchanged), so update touches only capacity. */
    private static EventPatch capacityPatch(int capacity) {
        return new EventPatch(
                null, null, null, null, null, null, null, null, null, null, null, null, capacity, null, null, null,
                null, null, null, null, null, null);
    }

    /** A PUBLISHED, visible-now event starting in two days, with the given capacity. */
    private Event publishedEvent(Integer capacity) {
        Instant now = Instant.now();
        User creator = users.save(new User("uid-caplow-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"));
        Event event = new Event(
                "Capacity-lower " + UUID.randomUUID(),
                "Capacity-shrink test fixture",
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
        String uid = "uid-caplow-" + tag + "-" + UUID.randomUUID();
        User user = users.save(new User(uid, tag + "-" + UUID.randomUUID() + "@example.com", tag));
        return new VerifiedUser(user.getFirebaseUid(), user.getEmail());
    }

    private long going(Event event) {
        return attendance.countByEventIdAndState(event.getId(), AttendanceState.GOING);
    }

    private AttendanceState stateOf(Event event, VerifiedUser caller) {
        Long userId = users.findByFirebaseUid(caller.uid()).orElseThrow().getId();
        return attendance
                .findByEventIdAndUserId(event.getId(), userId)
                .orElseThrow()
                .getState();
    }
}
