package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditEvent;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.BadRequestException;
import com.teammarhaba.backend.web.ConflictException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;

/**
 * The admin roster + capacity control operations (TM-592) end-to-end against a real Postgres, driving
 * the real {@code @Transactional} {@link EventRosterAdminService} alongside {@link EventRsvpService} and
 * {@link EventAdminService} so the {@code SELECT … FOR UPDATE} capacity reads are exact, never mocked.
 *
 * <p>Pins the owner-decided behaviours: raise-capacity frees spots (cascade eligible), lower-below-GOING
 * is accepted with an over-cap warning and no auto-eviction (and no new GOING joins until under cap, with
 * free-spots never negative), evict removes + frees a spot + re-RSVP allowed, and force-add respects
 * capacity/age/one-active by default and bypasses only with the audited override.
 */
class EventRosterAdminServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private EventRosterAdminService roster;

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

    @Autowired
    private AuditService audit;

    private VerifiedUser adminCaller;

    @org.junit.jupiter.api.BeforeEach
    void seedAdmin() {
        adminCaller = newCaller("admin");
    }

    // ---------------------------------------------------------------- capacity: raise

    @Test
    void raisingCapacityFreesSpotsAndReportsThemWithNoOverCap() {
        Event event = publishedEvent(2);
        rsvp("a", event);
        rsvp("b", event); // full at 2
        VerifiedUser queued = newCaller("queued");
        rsvps.rsvp(queued, event.getId());
        assertThat(stateOf(event, queued)).isEqualTo(AttendanceState.WAITLISTED);

        CapacityAdjustResult result = roster.adjustCapacity(adminCaller, event.getId(), 5);

        assertThat(result.capacity()).isEqualTo(5);
        assertThat(result.going()).isEqualTo(2);
        assertThat(result.freeSpots()).as("2 GOING out of a raised cap of 5 -> 3 free").isEqualTo(3);
        assertThat(result.isOverCapacity()).isFalse();
        assertThat(result.overCapacityBy()).isZero();
        // The freed spots are real: the waitlisted member can now claim one (the cascade polls this).
        assertThat(rsvps.claim(queued, event.getId()).state()).isEqualTo(AttendanceState.GOING);
    }

    // ---------------------------------------------------------------- capacity: lower below GOING

    @Test
    void loweringCapacityBelowGoingIsAcceptedWithOverCapWarningAndNeverAutoEvicts() {
        Event event = publishedEvent(4);
        rsvp("a", event);
        rsvp("b", event);
        rsvp("c", event);
        assertThat(going(event)).isEqualTo(3);

        CapacityAdjustResult result = roster.adjustCapacity(adminCaller, event.getId(), 1);

        // Accepted; no confirmed attendee bumped.
        assertThat(going(event)).as("no auto-eviction on a below-GOING shrink").isEqualTo(3);
        assertThat(event(event).getCapacity()).isEqualTo(1);
        // Warning surfaced: 3 GOING over a cap of 1 = 2 over cap.
        assertThat(result.isOverCapacity()).isTrue();
        assertThat(result.overCapacityBy()).isEqualTo(2);
        // Free-spots math clamps at >= 0 — never negative even while 2 over cap.
        assertThat(result.freeSpots()).isZero();

        // No new GOING joins until attendance drops under the new cap: a fresh RSVP waitlists.
        VerifiedUser newcomer = newCaller("newcomer");
        assertThat(rsvps.rsvp(newcomer, event.getId()).state()).isEqualTo(AttendanceState.WAITLISTED);
        assertThat(going(event)).isEqualTo(3);
    }

    @Test
    void makingCapacityUnlimitedRemovesTheCapAndReportsUnlimited() {
        Event event = publishedEvent(1);
        rsvp("a", event);

        CapacityAdjustResult result = roster.adjustCapacity(adminCaller, event.getId(), null);

        assertThat(event(event).getCapacity()).isNull();
        assertThat(result.capacity()).isNull();
        assertThat(result.freeSpots()).as("unlimited has no free-spot ceiling").isNull();
        assertThat(result.isOverCapacity()).isFalse();
    }

    @Test
    void negativeCapacityIsRejected() {
        Event event = publishedEvent(2);
        assertThatThrownBy(() -> roster.adjustCapacity(adminCaller, event.getId(), -1))
                .isInstanceOf(BadRequestException.class)
                .hasMessage(EventRosterAdminService.CAPACITY_NEGATIVE);
    }

    @Test
    void capacityAdjustAuditsTheChangeButNoOpDoesNot() {
        Event event = publishedEvent(2);
        long before = auditCount(event, AuditAction.EVENT_UPDATED);

        roster.adjustCapacity(adminCaller, event.getId(), 5);
        assertThat(auditCount(event, AuditAction.EVENT_UPDATED)).isEqualTo(before + 1);

        // Re-adjusting to the same value writes no audit row.
        roster.adjustCapacity(adminCaller, event.getId(), 5);
        assertThat(auditCount(event, AuditAction.EVENT_UPDATED)).isEqualTo(before + 1);
    }

    // ---------------------------------------------------------------- evict

    @Test
    void evictRemovesTheAttendeeFreesTheSpotAuditsItAndAllowsReRsvp() {
        Event event = publishedEvent(2);
        VerifiedUser target = newCaller("target");
        rsvps.rsvp(target, event.getId());
        long targetId = idOf(target);
        assertThat(stateOf(event, target)).isEqualTo(AttendanceState.GOING);

        RosterActionResult result = roster.evictAttendee(adminCaller, event.getId(), targetId);

        // Removed, spot freed, audited.
        assertThat(attendance.findByEventIdAndUserId(event.getId(), targetId)).isEmpty();
        assertThat(result.state()).isNull();
        assertThat(result.going()).isEqualTo(0);
        assertThat(auditCount(event, AuditAction.EVENT_ATTENDEE_EVICTED)).isEqualTo(1);

        // Not banned: the evicted user may re-RSVP and (a spot being free) lands GOING again.
        assertThat(rsvps.rsvp(target, event.getId()).state()).isEqualTo(AttendanceState.GOING);
    }

    @Test
    void evictOfSomeoneNotOnTheEventIsAnIdempotentNoOpThatStillAudits() {
        Event event = publishedEvent(2);
        VerifiedUser stranger = newCaller("stranger");
        long strangerId = idOf(stranger);

        RosterActionResult result = roster.evictAttendee(adminCaller, event.getId(), strangerId);

        assertThat(result.state()).isNull();
        assertThat(result.going()).isZero();
        assertThat(auditCount(event, AuditAction.EVENT_ATTENDEE_EVICTED)).isEqualTo(1);
    }

    @Test
    void evictOfAnUnknownUserIs404() {
        Event event = publishedEvent(2);
        assertThatThrownBy(() -> roster.evictAttendee(adminCaller, event.getId(), 9_999_999L))
                .isInstanceOf(ResourceNotFoundException.class);
    }

    // ---------------------------------------------------------------- force-add

    @Test
    void forceAddLandsTargetGoingJoinsAndAuditsWithOverrideFalse() {
        Event event = publishedEvent(3);
        VerifiedUser target = newCaller("target");
        long targetId = idOf(target);

        RosterActionResult result = roster.forceAddAttendee(adminCaller, event.getId(), targetId, false);

        assertThat(result.state()).isEqualTo(AttendanceState.GOING);
        assertThat(stateOf(event, target)).isEqualTo(AttendanceState.GOING);
        assertThat(going(event)).isEqualTo(1);
        AuditEvent row = latestAudit(event, AuditAction.EVENT_ATTENDEE_ADDED);
        assertThat(row.getMetadata()).containsEntry("override", "false");
        assertThat(row.getMetadata()).containsEntry("userId", String.valueOf(targetId));
    }

    @Test
    void forceAddRespectsCapacityByDefaultButOverrideBypassesIt() {
        Event event = publishedEvent(1);
        rsvp("a", event); // event is full at cap 1
        VerifiedUser target = newCaller("target");
        long targetId = idOf(target);

        // Default: refused — no oversell.
        assertThatThrownBy(() -> roster.forceAddAttendee(adminCaller, event.getId(), targetId, false))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRosterAdminService.EVENT_FULL);
        assertThat(going(event)).isEqualTo(1);

        // Audited override: force-add over capacity is allowed and recorded.
        RosterActionResult result = roster.forceAddAttendee(adminCaller, event.getId(), targetId, true);
        assertThat(result.state()).isEqualTo(AttendanceState.GOING);
        assertThat(going(event)).as("override lands GOING over the cap").isEqualTo(2);
        assertThat(latestAudit(event, AuditAction.EVENT_ATTENDEE_ADDED).getMetadata())
                .containsEntry("override", "true");
    }

    @Test
    void forceAddRespectsOneActiveGoingByDefaultButOverrideBypassesIt() {
        // The target is already GOING to another live event.
        Event other = publishedEvent(5);
        VerifiedUser target = newCaller("target");
        rsvps.rsvp(target, other.getId());
        long targetId = idOf(target);

        Event event = publishedEvent(5);

        // Default: refused, naming the blocker.
        assertThatThrownBy(() -> roster.forceAddAttendee(adminCaller, event.getId(), targetId, false))
                .isInstanceOf(ConflictException.class);
        assertThat(attendance.findByEventIdAndUserId(event.getId(), targetId)).isEmpty();

        // Override: added GOING despite the existing commitment.
        assertThat(roster.forceAddAttendee(adminCaller, event.getId(), targetId, true).state())
                .isEqualTo(AttendanceState.GOING);
    }

    @Test
    void forceAddOfSomeoneAlreadyGoingIsIdempotent() {
        Event event = publishedEvent(3);
        VerifiedUser target = newCaller("target");
        rsvps.rsvp(target, event.getId());
        long targetId = idOf(target);

        RosterActionResult result = roster.forceAddAttendee(adminCaller, event.getId(), targetId, false);
        assertThat(result.state()).isEqualTo(AttendanceState.GOING);
        assertThat(going(event)).isEqualTo(1);
        // No duplicate add audit for an already-GOING target.
        assertThat(auditCount(event, AuditAction.EVENT_ATTENDEE_ADDED)).isZero();
    }

    @Test
    void forceAddPromotesAnExistingWaitlistRowKeepingItsQueueRow() {
        Event event = publishedEvent(1);
        rsvp("a", event); // fills the single spot
        VerifiedUser target = newCaller("target");
        rsvps.rsvp(target, event.getId());
        long targetId = idOf(target);
        assertThat(stateOf(event, target)).isEqualTo(AttendanceState.WAITLISTED);

        // Override force-add promotes the WAITLISTED row to GOING (over cap).
        roster.forceAddAttendee(adminCaller, event.getId(), targetId, true);
        assertThat(stateOf(event, target)).isEqualTo(AttendanceState.GOING);
        assertThat(going(event)).isEqualTo(2);
    }

    @Test
    void forceAddOfAnUnknownUserIs404() {
        Event event = publishedEvent(2);
        assertThatThrownBy(() -> roster.forceAddAttendee(adminCaller, event.getId(), 9_999_999L, false))
                .isInstanceOf(ResourceNotFoundException.class);
    }

    // ---------------------------------------------------------------- roster read

    @Test
    void rosterListsGoingThenWaitlistAndFlagsOverCapMembers() {
        Event event = publishedEvent(2);
        rsvp("a", event);
        rsvp("b", event);
        VerifiedUser queued = newCaller("queued");
        rsvps.rsvp(queued, event.getId());

        // Shrink to 1 so 1 of the 2 GOING sits over cap.
        roster.adjustCapacity(adminCaller, event.getId(), 1);

        EventRosterAdminService.Roster r = roster.roster(event.getId());
        assertThat(r.going()).isEqualTo(2);
        assertThat(r.waitlist()).isEqualTo(1);
        List<EventRosterAdminService.RosterEntry> going =
                r.entries().stream().filter(e -> e.state() == AttendanceState.GOING).toList();
        assertThat(going).hasSize(2);
        assertThat(going.get(0).overCapacity()).as("1st GOING within cap 1").isFalse();
        assertThat(going.get(1).overCapacity()).as("2nd GOING over cap 1").isTrue();
        assertThat(r.entries().stream().filter(e -> e.state() == AttendanceState.WAITLISTED)).hasSize(1);
    }

    // ---------------------------------------------------------------- fixtures

    private Event publishedEvent(Integer capacity) {
        Instant now = Instant.now();
        User creator =
                users.save(new User("uid-roster-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"));
        Event event = new Event(
                "Roster " + UUID.randomUUID(),
                "Roster admin test fixture",
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
        String uid = "uid-roster-" + tag + "-" + UUID.randomUUID();
        User user = users.save(new User(uid, tag + "-" + UUID.randomUUID() + "@example.com", tag));
        return new VerifiedUser(user.getFirebaseUid(), user.getEmail());
    }

    private void rsvp(String tag, Event event) {
        rsvps.rsvp(newCaller(tag), event.getId());
    }

    private long idOf(VerifiedUser caller) {
        return users.findByFirebaseUid(caller.uid()).orElseThrow().getId();
    }

    private long going(Event event) {
        return attendance.countByEventIdAndState(event.getId(), AttendanceState.GOING);
    }

    private Event event(Event event) {
        return events.findById(event.getId()).orElseThrow();
    }

    private AttendanceState stateOf(Event event, VerifiedUser caller) {
        return attendance
                .findByEventIdAndUserId(event.getId(), idOf(caller))
                .orElseThrow()
                .getState();
    }

    private long auditCount(Event event, AuditAction action) {
        return audit
                .search(null, EventRosterAdminService.TARGET_EVENT, String.valueOf(event.getId()), PageRequest.of(0, 50))
                .stream()
                .filter(e -> e.getAction() == action)
                .count();
    }

    private AuditEvent latestAudit(Event event, AuditAction action) {
        return audit
                .search(null, EventRosterAdminService.TARGET_EVENT, String.valueOf(event.getId()), PageRequest.of(0, 50))
                .stream()
                .filter(e -> e.getAction() == action)
                .findFirst()
                .orElseThrow();
    }
}
