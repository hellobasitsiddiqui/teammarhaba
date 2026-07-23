package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditEvent;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.chat.Conversation;
import com.teammarhaba.backend.chat.ConversationMember;
import com.teammarhaba.backend.chat.ConversationMemberRepository;
import com.teammarhaba.backend.chat.ConversationRepository;
import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.notify.PushDelivery;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushSender;
import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.BadRequestException;
import com.teammarhaba.backend.web.ConflictException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
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
 *
 * <p>Also pins the side-effect contracts the ticket requires, driven end-to-end: evict → the target is
 * dropped from the event group chat ({@code REMOVED}) and notified; force-add → the target is joined to
 * the chat ({@code MEMBER}) and notified; a raise-capacity offers the freed spot to the waitlist via the
 * real {@link WaitlistOfferCascadeService}. The push is deferred to AFTER_COMMIT (TM-730), so the whole
 * publish → commit → listener → fan-out chain is exercised with only the outermost {@link PushSender}
 * swapped for a recording fake — proving no FCM round-trip runs under the event lock.
 */
@Import(EventRosterAdminServiceIntegrationTest.RecordingSenderConfig.class)
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

    @Autowired
    private WaitlistOfferCascadeService cascade;

    @Autowired
    private ConversationRepository conversations;

    @Autowired
    private ConversationMemberRepository members;

    @Autowired
    private DeviceTokenRepository deviceTokens;

    @Autowired
    private RecordingPushSender sender;

    @Autowired
    private org.springframework.jdbc.core.JdbcTemplate jdbcTemplate;

    @Autowired
    private LifecycleEventRecorder lifecycleRecorder;

    private final List<EventLifecycleEvent> lifecycleEvents = new java.util.concurrent.CopyOnWriteArrayList<>();

    private VerifiedUser adminCaller;

    @org.junit.jupiter.api.BeforeEach
    void seedAdmin() {
        adminCaller = newCaller("admin");
        sender.reset();
        lifecycleRecorder.bindTo(lifecycleEvents);
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

    @Test
    void raisingCapacityTriggersTheWaitlistOfferCascadeToOfferTheFreedSpotFifo() {
        // A raise must not merely make a claim mathematically possible — it must actively OFFER the freed
        // spot to the FIFO waitlist head. Proven by driving the real cascade after the raise and asserting
        // the waitlisted member's live offer stamp is set (mirrors WaitlistOfferCascadeIntegrationTest),
        // not by claim() alone (claim lands GOING from free-spot math and never needs an offer).
        Event event = publishedEvent(2);
        rsvp("a", event);
        rsvp("b", event); // full at 2
        VerifiedUser queued = newCaller("queued");
        rsvps.rsvp(queued, event.getId());
        long queuedId = idOf(queued);
        assertThat(offerStampOf(event, queuedId)).as("no offer while the event is full").isNull();
        lifecycleEvents.clear();

        roster.adjustCapacity(adminCaller, event.getId(), 5); // frees 3 spots

        // The immediate offer-cascade trigger (TM-397): a raise publishes an UPDATED lifecycle signal
        // carrying the "capacity" changed field, so the cascade is nudged at once rather than only on the
        // next poll. Pins the trigger itself (removing the publish makes this fail), not just its outcome.
        assertThat(lifecycleEvents.stream()
                        .filter(e -> e.eventId() == event.getId()
                                && e.kind() == EventLifecycleEvent.Kind.UPDATED
                                && e.changedFields().contains("capacity")))
                .as("a raise publishes the UPDATED{capacity} cascade trigger")
                .hasSize(1);

        // ...and the freed spot is really offered to the FIFO head when the cascade runs.
        int offered = cascade.sweepOpenOffers();
        assertThat(offered).as("the raise freed a spot the cascade offers").isEqualTo(1);
        assertThat(offerStampOf(event, queuedId))
                .as("the waitlisted member holds a live offer after the raise")
                .isNotNull();
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
                .hasMessage(EventRosterAdminService.CAPACITY_BELOW_MIN);
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
    void evictDropsTheTargetFromTheEventChatAsRemoved() {
        // TM-446 sync: an evicted attendee's group-chat membership goes inactive (REMOVED), exactly as a
        // self-leave does. Regression-guards EventRosterAdminService's chatLifecycle.onLeave call.
        Event event = publishedEvent(2);
        VerifiedUser target = newCaller("target");
        rsvps.rsvp(target, event.getId()); // GOING → joins (and lazily creates) the group thread
        long targetId = idOf(target);
        Conversation thread = conversations.findByEventId(event.getId()).orElseThrow();
        assertThat(membership(thread, targetId).isActive()).as("GOING attendee is an active chat member").isTrue();

        roster.evictAttendee(adminCaller, event.getId(), targetId);

        assertThat(membership(thread, targetId).isActive())
                .as("evicted attendee is dropped from the chat (REMOVED)")
                .isFalse();
    }

    @Test
    void evictNotifiesTheEvictedTargetAfterCommitButNotOnAnIdempotentNoOp() {
        // TM-592 "evict → notified", TM-730 "push fires post-commit". A device-owning target that is
        // actually removed gets exactly one "spot was removed" push; a no-op evict of someone never on the
        // event pushes nobody.
        Event event = publishedEvent(2);
        VerifiedUser target = attendeeWithDevice("evict-notify", "tok-evict");
        rsvps.rsvp(target, event.getId());
        long targetId = idOf(target);
        sender.reset();

        roster.evictAttendee(adminCaller, event.getId(), targetId);

        List<PushMessage> pushes = pushesTo("tok-evict");
        assertThat(pushes).hasSize(1);
        assertThat(pushes.get(0).title()).startsWith("Your spot was removed:");
        assertThat(pushes.get(0).route()).isEqualTo("#/events/" + event.getId());

        // Idempotent no-op evict of someone never on the event notifies nobody.
        sender.reset();
        VerifiedUser stranger = attendeeWithDevice("evict-stranger", "tok-stranger");
        roster.evictAttendee(adminCaller, event.getId(), idOf(stranger));
        assertThat(pushesTo("tok-stranger")).as("a no-op evict pings nobody").isEmpty();
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

    @Test
    void evictOfASoftDeletedTargetIs404Cleanly() {
        // TM-967(b): a roster action on a soft-deleted (tombstoned) target 404s cleanly — the User's
        // @SQLRestriction hides the row from findById, so it resolves to a plain "User not found" rather
        // than a constraint-violation 500. Guards that the not-found path also covers tombstoned accounts.
        Event event = publishedEvent(2);
        VerifiedUser target = newCaller("tombstoned");
        long targetId = idOf(target);
        softDeleteUser(targetId);

        assertThatThrownBy(() -> roster.evictAttendee(adminCaller, event.getId(), targetId))
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
    void forceAddJoinsTheTargetToTheEventChatAsAnActiveMember() {
        // TM-446 sync: a force-added GOING landing joins (and lazily creates) the group thread as an active
        // MEMBER, exactly as an RSVP does. Regression-guards chatLifecycle.onGoing.
        Event event = publishedEvent(3);
        VerifiedUser target = newCaller("target");
        long targetId = idOf(target);

        roster.forceAddAttendee(adminCaller, event.getId(), targetId, false);

        Conversation thread = conversations.findByEventId(event.getId()).orElseThrow();
        assertThat(membership(thread, targetId).isActive())
                .as("force-added attendee is an active chat member")
                .isTrue();
    }

    @Test
    void forceAddNotifiesTheAddedTargetAfterCommit() {
        // TM-592 "force-add → notify", TM-730 "push fires post-commit". The added device-owning target
        // gets exactly one "you're in" push.
        Event event = publishedEvent(3);
        VerifiedUser target = attendeeWithDevice("add-notify", "tok-add");
        long targetId = idOf(target);
        sender.reset();

        roster.forceAddAttendee(adminCaller, event.getId(), targetId, false);

        List<PushMessage> pushes = pushesTo("tok-add");
        assertThat(pushes).hasSize(1);
        assertThat(pushes.get(0).title()).startsWith("You're in:");
        assertThat(pushes.get(0).route()).isEqualTo("#/events/" + event.getId());
    }

    @Test
    void forceAddDoesNotReNotifyAnAlreadyGoingTarget() {
        // The idempotent already-GOING short-circuit publishes no EventAttendeeChangedEvent, so no push.
        Event event = publishedEvent(3);
        VerifiedUser target = attendeeWithDevice("add-idem", "tok-idem");
        rsvps.rsvp(target, event.getId()); // already GOING
        sender.reset();

        roster.forceAddAttendee(adminCaller, event.getId(), idOf(target), false);

        assertThat(pushesTo("tok-idem")).as("an idempotent force-add of an already-GOING member pings nobody").isEmpty();
    }

    @Test
    void forceAddRespectsTheAgeBandByDefaultButOverrideBypassesIt() {
        // The third default guard (alongside capacity + one-active): a target outside the event's age band
        // is refused unless override is set. Band 25–30 (±2 tolerance → 23–32); target aged 18 is out.
        Event event = publishedEvent(5);
        Event banded = events.findById(event.getId()).orElseThrow();
        banded.setAgeMin(25);
        banded.setAgeMax(30);
        events.saveAndFlush(banded);

        VerifiedUser target = newCaller("young");
        User youngUser = users.findByFirebaseUid(target.uid()).orElseThrow();
        youngUser.setAge(18); // comfortably below 23 (25 − 2 tolerance)
        users.saveAndFlush(youngUser);
        long targetId = idOf(target);

        // Default: refused, no GOING row created.
        assertThatThrownBy(() -> roster.forceAddAttendee(adminCaller, event.getId(), targetId, false))
                .isInstanceOf(ConflictException.class);
        assertThat(attendance.findByEventIdAndUserId(event.getId(), targetId)).isEmpty();

        // Audited override bypasses the age band.
        assertThat(roster.forceAddAttendee(adminCaller, event.getId(), targetId, true).state())
                .isEqualTo(AttendanceState.GOING);
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

    // ---------------------------------------------------------------- finished-event freeze

    @Test
    void adjustCapacityOnAFinishedEventIsFrozen() {
        Event event = finishedEvent(2);
        assertThatThrownBy(() -> roster.adjustCapacity(adminCaller, event.getId(), 5))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventAdminService.EVENT_ENDED_EDIT);
        assertThat(event(event).getCapacity()).as("a finished event's capacity is not re-opened").isEqualTo(2);
    }

    @Test
    void forceAddOnAFinishedEventIsFrozen() {
        Event event = finishedEvent(5);
        VerifiedUser target = newCaller("late");
        long targetId = idOf(target);
        assertThatThrownBy(() -> roster.forceAddAttendee(adminCaller, event.getId(), targetId, false))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventAdminService.EVENT_ENDED_EDIT);
        // Even override cannot resurrect a finished event.
        assertThatThrownBy(() -> roster.forceAddAttendee(adminCaller, event.getId(), targetId, true))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventAdminService.EVENT_ENDED_EDIT);
        assertThat(attendance.findByEventIdAndUserId(event.getId(), targetId)).isEmpty();
    }

    @Test
    void evictOnAFinishedEventIsFrozenAndDeletesNoHistory() {
        // TM-993: evict must take the SAME finished-event freeze its siblings do. Without the guard,
        // evicting a finished-event GOING row deletes historical attendance (and retroactively unlocks
        // the TM-907 name lock derived live from hasGoingAtFinishedEvent). The attendance row must survive.
        Instant now = Instant.now();
        Event event = finishedEvent(2);
        VerifiedUser target = newCaller("attended");
        long targetId = idOf(target);
        // Seed a GOING row directly (the RSVP verb refuses a finished event), so there IS history to protect.
        attendance.saveAndFlush(new EventAttendance(event.getId(), targetId, AttendanceState.GOING));

        assertThatThrownBy(() -> roster.evictAttendee(adminCaller, event.getId(), targetId))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventAdminService.EVENT_ENDED_EDIT);
        assertThat(attendance.findByEventIdAndUserId(event.getId(), targetId))
                .as("a finished event's attendance history is not deleted by an evict")
                .isPresent();
    }

    @Test
    void evictOnACancelledEventIsFrozenAndDeletesNoHistory() {
        // TM-993: a CANCELLED event keeps its attendance as readable history (cancel != delete). Evicting a
        // row from it would mutate that frozen record — reject with a 409 and leave the row intact.
        Event event = cancelledEvent(2);
        VerifiedUser target = newCaller("attendee");
        long targetId = idOf(target);
        attendance.saveAndFlush(new EventAttendance(event.getId(), targetId, AttendanceState.GOING));

        assertThatThrownBy(() -> roster.evictAttendee(adminCaller, event.getId(), targetId))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRosterAdminService.EVENT_CANCELLED_ROSTER);
        assertThat(attendance.findByEventIdAndUserId(event.getId(), targetId))
                .as("a cancelled event's kept history is not deleted by an evict")
                .isPresent();
    }

    @Test
    void forceAddOnACancelledEventIsFrozenEvenWithOverride() {
        // TM-967(a): force-add has no event-STATUS gate before this fix, so it could act on a CANCELLED
        // event. Reject with a 409; even override cannot add an attendee to a called-off event.
        Event event = cancelledEvent(5);
        VerifiedUser target = newCaller("late");
        long targetId = idOf(target);

        assertThatThrownBy(() -> roster.forceAddAttendee(adminCaller, event.getId(), targetId, false))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRosterAdminService.EVENT_CANCELLED_ROSTER);
        assertThatThrownBy(() -> roster.forceAddAttendee(adminCaller, event.getId(), targetId, true))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRosterAdminService.EVENT_CANCELLED_ROSTER);
        assertThat(attendance.findByEventIdAndUserId(event.getId(), targetId)).isEmpty();
    }

    // ---------------------------------------------------------------- capacity: reject < 1 (TM-964)

    @Test
    void adjustCapacityToZeroIsRejected() {
        // TM-964: capacity 0 is settable ONLY through the roster adjust (create/edit enforce @Min(1)); once
        // set the edit form prefills "0", errors on the untouched field, and blocks ALL unrelated edits.
        // The adjust now rejects < 1 to align with @Min(1), so capacity 0 can never be reached.
        Event event = publishedEvent(2);
        assertThatThrownBy(() -> roster.adjustCapacity(adminCaller, event.getId(), 0))
                .isInstanceOf(BadRequestException.class)
                .hasMessage(EventRosterAdminService.CAPACITY_BELOW_MIN);
        assertThat(event(event).getCapacity()).as("capacity stays at 2, never becomes 0").isEqualTo(2);
    }

    // ---------------------------------------------------------------- stale-offer cleanup

    @Test
    void forceAddFillingTheLastSpotVoidsOtherWaitlistersOpenOffers() {
        // TM-397 cascade-stop parity with claim: when a force-add consumes the last free spot, every other
        // waitlister's live offer is voided immediately (not left dangling until the next cascade sweep),
        // so nobody keeps seeing a "spot available to claim" banner for a spot that's gone.
        Event ev = publishedEvent(1);
        rsvp("g", ev); // GOING — fills the single spot
        VerifiedUser wl1 = newCaller("wl1");
        VerifiedUser wl2 = newCaller("wl2");
        rsvps.rsvp(wl1, ev.getId()); // WAITLISTED
        rsvps.rsvp(wl2, ev.getId()); // WAITLISTED
        long wl1Id = idOf(wl1);
        long wl2Id = idOf(wl2);

        // Raise to 2 so exactly one spot frees, then let the cascade offer the FIFO head a live offer.
        roster.adjustCapacity(adminCaller, ev.getId(), 2);
        cascade.sweepOpenOffers();
        assertThat(offerStampOf(ev, wl1Id)).as("wl1 was offered the freed spot").isNotNull();

        // Force-add a THIRD user with override — this consumes the last free spot (going 1 → 2 == cap 2).
        VerifiedUser x = newCaller("x");
        roster.forceAddAttendee(adminCaller, ev.getId(), idOf(x), true);

        // The last-spot fill voids the remaining live offers immediately (mirrors claim's clearOpenOffers).
        assertThat(offerStampOf(ev, wl1Id)).as("wl1's stale offer is voided on the last-spot force-add").isNull();
        assertThat(offerStampOf(ev, wl2Id)).isNull();
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

    /** A PUBLISHED event whose start AND end are in the past, so {@code EventPhasePolicy.isFinished}. */
    private Event finishedEvent(Integer capacity) {
        Instant now = Instant.now();
        User creator =
                users.save(new User("uid-roster-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"));
        Event event = new Event(
                "Roster " + UUID.randomUUID(),
                "Finished roster fixture",
                "Marhaba Cafe",
                "Europe/London",
                now.minus(2, ChronoUnit.DAYS), // startAt in the past
                now.minus(3, ChronoUnit.DAYS), // visibilityStart
                now.plus(1, ChronoUnit.DAYS), // visibilityEnd (still visible, just over)
                creator.getId(),
                now);
        event.setEndAt(now.minus(1, ChronoUnit.DAYS)); // ended yesterday → finished
        event.setCapacity(capacity);
        return events.save(event);
    }

    /** A CANCELLED (called-off) but still-upcoming event, so it is frozen by status, not by finish time. */
    private Event cancelledEvent(Integer capacity) {
        Event event = publishedEvent(capacity);
        event.cancel(Instant.now());
        return events.saveAndFlush(event);
    }

    /** Tombstone a user via native SQL (User.markDeleted is package-private) so findById hides the row. */
    private void softDeleteUser(long userId) {
        jdbcTemplate.update("UPDATE users SET deleted_at = now() WHERE id = ?", userId);
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

    /** A caller backed by a real PUSH-opted-in user with one device token, so pushes to them are observable. */
    private VerifiedUser attendeeWithDevice(String tag, String token) {
        String uid = "uid-roster-" + tag + "-" + UUID.randomUUID();
        User user = users.save(new User(uid, tag + "-" + UUID.randomUUID() + "@example.com", tag));
        user.setNotificationPref(NotificationPref.PUSH); // EMAIL (default) is the push opt-out
        long userId = users.saveAndFlush(user).getId();
        deviceTokens.saveAndFlush(new DeviceToken(userId, token, DevicePlatform.ANDROID, Instant.now()));
        return new VerifiedUser(uid, user.getEmail());
    }

    private ConversationMember membership(Conversation thread, long userId) {
        return members.findByConversationIdAndUserId(thread.getId(), userId).orElseThrow();
    }

    private Instant offerStampOf(Event event, long userId) {
        return attendance
                .findByEventIdAndUserId(event.getId(), userId)
                .orElseThrow()
                .getOfferNotifiedAt();
    }

    /** The push messages delivered to the given device token by the AFTER_COMMIT listener. */
    private List<PushMessage> pushesTo(String token) {
        return sender.deliveries().stream()
                .filter(d -> d.token().equals(token))
                .map(Delivery::message)
                .toList();
    }

    // ---------------------------------------------------------------- push-recording harness

    @TestConfiguration
    static class RecordingSenderConfig {
        @Bean
        @Primary
        RecordingPushSender recordingPushSender() {
            return new RecordingPushSender();
        }

        @Bean
        LifecycleEventRecorder lifecycleEventRecorder() {
            return new LifecycleEventRecorder();
        }
    }

    /**
     * Captures every {@link EventLifecycleEvent} at publish time (a plain {@code @EventListener}, so it
     * fires synchronously in the publishing transaction — the raise trigger is the publish itself, not a
     * post-commit side effect). Bound to the current test's list in {@code @BeforeEach}.
     */
    static final class LifecycleEventRecorder {
        private volatile List<EventLifecycleEvent> sink;

        void bindTo(List<EventLifecycleEvent> sink) {
            this.sink = sink;
        }

        @org.springframework.context.event.EventListener
        void onLifecycle(EventLifecycleEvent event) {
            List<EventLifecycleEvent> current = sink;
            if (current != null) {
                current.add(event);
            }
        }
    }

    record Delivery(String token, PushMessage message) {}

    static final class RecordingPushSender implements PushSender {
        private final List<Delivery> deliveries = new ArrayList<>();

        @Override
        public synchronized PushDelivery send(String token, PushMessage message) {
            deliveries.add(new Delivery(token, message));
            return PushDelivery.DELIVERED;
        }

        synchronized List<Delivery> deliveries() {
            return List.copyOf(deliveries);
        }

        synchronized void reset() {
            deliveries.clear();
        }
    }
}
