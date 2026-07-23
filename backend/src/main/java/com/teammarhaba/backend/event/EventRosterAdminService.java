package com.teammarhaba.backend.event;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.BadRequestException;
import com.teammarhaba.backend.web.ConflictException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Admin roster + capacity control (TM-592) — the capacity-affecting admin operations that
 * {@link EventAdminService} (create/edit/cancel) deliberately does not own, because each one must take
 * the very same {@code SELECT … FOR UPDATE} lock discipline as {@link EventRsvpService}:
 *
 * <ul>
 *   <li>{@link #adjustCapacity} — a first-class capacity increase/decrease (not buried in the full
 *       edit form). An increase frees spots the waitlist offer cascade (TM-397) then picks up; a
 *       decrease below the current {@code GOING} count is <em>allowed</em> per the owner decision —
 *       the event sits over-cap, no confirmed attendee is auto-evicted, and the result carries the
 *       over-cap warning.</li>
 *   <li>{@link #evictAttendee} — remove a specific attendee's {@code GOING}/{@code WAITLISTED} row,
 *       drop them from the event chat, notify them and audit it. A freed {@code GOING} spot is cascade
 *       eligible; the evicted user is not banned and may re-RSVP.</li>
 *   <li>{@link #forceAddAttendee} — add a specific existing user as {@code GOING}, join the chat,
 *       notify and audit. Respects capacity + age/eligibility + the one-active-GOING guard BY DEFAULT;
 *       an explicit audited {@code override} flag bypasses those guards (still oversell-safe — the write
 *       is under the event lock).</li>
 * </ul>
 *
 * <p><b>Locking discipline.</b> Every op here runs in its own transaction and takes the SAME locks the
 * RSVP verbs take, in the SAME user-then-event order (TM-423) to stay deadlock-free with concurrent
 * RSVP/claim/cancel: the target user's {@code users} row lock first (only where a {@code GOING} landing
 * is involved — evict never lands GOING and does not need it, but force-add and the shared count reads
 * must be exact), then the event {@code SELECT … FOR UPDATE} lock ({@link EventRepository#findByIdForUpdate}).
 * Because both this service and {@link EventRsvpService} serialise on the same event row, an admin op can
 * never race a member RSVP into an oversell.
 *
 * <p><b>Reused seams.</b> Chat membership sync goes through {@link EventChatLifecycleService} (evict →
 * {@code onLeave}/REMOVED, force-add → {@code onGoing}/active member) exactly as an RSVP/leave does; the
 * target's push is deferred to <em>after commit</em> by publishing an {@link EventAttendeeChangedEvent}
 * that {@link EventLifecycleNotifier} fans out post-commit ({@code @TransactionalEventListener}), so the
 * FCM round-trip never runs under the event lock / on the pooled connection (TM-730) — the same discipline
 * {@link EventClaimedEvent} uses; the audit goes through {@link AuditService}
 * ({@link AuditAction#EVENT_ATTENDEE_EVICTED}/{@link AuditAction#EVENT_ATTENDEE_ADDED}); and a
 * lifecycle {@link EventLifecycleEvent} is published so the TM-397 seam (and the offer cascade) sees the
 * change. Age eligibility reuses {@link AgeEligibilityPolicy}, and the one-active-GOING guard reuses
 * {@link EventRepository#findActiveGoingForUser} — never re-derived here.
 */
@Service
public class EventRosterAdminService {

    /** Audit {@code target_type} for event rows (mirrors {@link EventAdminService#TARGET_EVENT}). */
    static final String TARGET_EVENT = "Event";

    /**
     * 400 copy when a capacity adjust carries a value below 1 (TM-964). Aligned to the create/edit form's
     * {@code @Min(1)} so the roster adjust can never leave an event at capacity 0 — a 0 the edit form then
     * prefills and rejects, blocking every unrelated edit. {@code null} still means "unlimited".
     */
    static final String CAPACITY_BELOW_MIN = "Capacity must be at least 1 (leave blank for unlimited).";

    /** 409 copy when a roster action targets a CANCELLED event (TM-993/TM-967) — its history is frozen. */
    static final String EVENT_CANCELLED_ROSTER =
            "This event has been cancelled and its roster can no longer be changed.";

    /** 409 copy when a force-add would oversell a capacity-limited event (and no override was given). */
    static final String EVENT_FULL = "This event is full — raise the capacity or use the override to force-add.";

    /** 409 copy when force-adding a user who already holds a GOING spot on another live event (no override). */
    static String activeEventBlock(String blockingHeading) {
        return "This user is already going to \"" + blockingHeading
                + "\" until it ends, and can only be going to one event at a time. Use the override to force-add anyway.";
    }

    private final EventRepository events;
    private final EventAttendanceRepository attendance;
    private final UserRepository users;
    private final AuditService audit;
    private final ApplicationEventPublisher lifecycle;
    private final EventChatLifecycleService chatLifecycle;
    private final AgeEligibilityPolicy ageGate;
    private final EventPhasePolicy phasePolicy;

    public EventRosterAdminService(
            EventRepository events,
            EventAttendanceRepository attendance,
            UserRepository users,
            AuditService audit,
            ApplicationEventPublisher lifecycle,
            EventChatLifecycleService chatLifecycle,
            AgeEligibilityPolicy ageGate,
            EventPhasePolicy phasePolicy) {
        this.events = events;
        this.attendance = attendance;
        this.users = users;
        this.audit = audit;
        this.lifecycle = lifecycle;
        this.chatLifecycle = chatLifecycle;
        this.ageGate = ageGate;
        this.phasePolicy = phasePolicy;
    }

    /**
     * One attendee on the admin roster (TM-592): who they are and the state they hold. GOING first
     * (join order), then the waitlist in FIFO order — the order the console renders.
     *
     * @param userId      the attendee's {@code users.id} (the evict/target key the console posts back)
     * @param displayName their profile name (may be {@code null} — the console shows a placeholder)
     * @param state       {@code GOING} or {@code WAITLISTED}
     * @param overCapacity {@code true} for a GOING attendee whose position sits over the current cap —
     *                     the console flags them (they are never auto-evicted, per the owner decision)
     */
    public record RosterEntry(Long userId, String displayName, AttendanceState state, boolean overCapacity) {}

    /** The full admin roster for one event: GOING (join order) then WAITLISTED (FIFO), plus the counts. */
    public record Roster(
            long eventId, Integer capacity, long going, long waitlist, List<RosterEntry> entries) {}

    /**
     * The admin roster for one event (TM-592) — GOING attendees in join order followed by the waitlist in
     * FIFO order, each resolved to a display name through {@link UserRepository} (soft-deleted accounts
     * silently drop out, exactly as the public avatar strip does). A GOING attendee whose 1-based position
     * exceeds the current capacity is flagged {@code overCapacity} so the console can show which committed
     * members currently sit over a lowered cap. Read-only; no lock needed (a plain snapshot for display).
     */
    @Transactional(readOnly = true)
    public Roster roster(long eventId) {
        Event event = events.findById(eventId).orElseThrow(EventRosterAdminService::notFound);
        List<EventAttendance> going =
                attendance.findByEventIdAndState(eventId, AttendanceState.GOING, PageRequest.of(0, MAX_ROSTER));
        List<EventAttendance> waitlist = attendance.findWaitlistFifo(eventId);

        // One batch read for every attendee's display name (no N+1); tombstoned accounts simply aren't
        // returned, so they drop out of the roster.
        List<Long> ids = new ArrayList<>();
        going.forEach(a -> ids.add(a.getUserId()));
        waitlist.forEach(a -> ids.add(a.getUserId()));
        Map<Long, User> byId =
                users.findAllById(ids).stream().collect(Collectors.toMap(User::getId, u -> u));

        Integer capacity = event.getCapacity();
        List<RosterEntry> entries = new ArrayList<>();
        int goingPosition = 0;
        for (EventAttendance a : going) {
            User u = byId.get(a.getUserId());
            if (u == null) {
                continue; // soft-deleted account — drop it, like the avatar strip
            }
            goingPosition++;
            boolean over = capacity != null && goingPosition > capacity;
            entries.add(new RosterEntry(u.getId(), u.getDisplayName(), AttendanceState.GOING, over));
        }
        for (EventAttendance a : waitlist) {
            User u = byId.get(a.getUserId());
            if (u == null) {
                continue;
            }
            entries.add(new RosterEntry(u.getId(), u.getDisplayName(), AttendanceState.WAITLISTED, false));
        }
        long goingCount = attendance.countByEventIdAndState(eventId, AttendanceState.GOING);
        long waitlistCount = attendance.countByEventIdAndState(eventId, AttendanceState.WAITLISTED);
        return new Roster(eventId, capacity, goingCount, waitlistCount, entries);
    }

    /** Cap the roster read to a sane page — an event's GOING list is bounded by capacity in practice. */
    private static final int MAX_ROSTER = 1000;

    /**
     * Adjust an event's capacity as a first-class action (TM-592) — increase or decrease.
     *
     * <ul>
     *   <li><b>Increase</b> — frees spots. The write commits under the event lock; the offer cascade
     *       (TM-397) polls free spots, so it picks the freed capacity up on its next sweep and offers the
     *       waitlist FIFO. Publishing an {@code UPDATED} lifecycle signal is the immediate seam trigger.</li>
     *   <li><b>Decrease below the current {@code GOING} count</b> — ALLOWED (owner decision): no confirmed
     *       attendee is auto-evicted, so the event sits over-cap. New RSVPs waitlist and no new GOING joins
     *       land until attendance drops under the new cap (the RSVP/claim verbs already read this exact
     *       capacity under the same lock). The returned {@link CapacityAdjustResult} carries the warning:
     *       how many attendees are over cap, and a free-spot figure clamped at {@code ≥ 0}.</li>
     *   <li><b>{@code null} capacity</b> — make the event unlimited (removes the cap). Any value below 1
     *       (0 or negative) is a {@code 400} (TM-964): capacity 0 is not settable here, so it can never be
     *       reached, keeping the roster adjust in lock-step with the create/edit form's {@code @Min(1)}.</li>
     * </ul>
     *
     * <p>Capacity-locked: takes the event {@code SELECT … FOR UPDATE} lock so the going/waitlist counts
     * read are exact and the write can never race a concurrent RSVP into an oversell. A no-op adjust (the
     * capacity is already the requested value) still returns the derived result but writes no audit /
     * lifecycle signal. A past (finished) event is frozen ({@code 409}), mirroring
     * {@link EventAdminService#update}.
     */
    @Transactional
    public CapacityAdjustResult adjustCapacity(VerifiedUser admin, long eventId, Integer newCapacity) {
        // TM-964: reject any capacity < 1, aligning the roster adjust to the create/edit form's @Min(1).
        // A 0 capacity is otherwise settable ONLY through this path, and once set the edit form prefills
        // "0", errors on the @Min(1) field, and blocks every unrelated edit. `null` = unlimited (no cap).
        if (newCapacity != null && newCapacity < 1) {
            throw new BadRequestException(CAPACITY_BELOW_MIN);
        }
        Instant now = Instant.now();
        Event event = lockedEvent(eventId);
        if (phasePolicy.isFinished(event, now)) {
            throw new ConflictException(EventAdminService.EVENT_ENDED_EDIT);
        }
        long going = attendance.countByEventIdAndState(eventId, AttendanceState.GOING);
        long waitlist = attendance.countByEventIdAndState(eventId, AttendanceState.WAITLISTED);

        boolean changed = !java.util.Objects.equals(event.getCapacity(), newCapacity);
        if (changed) {
            event.setCapacity(newCapacity); // dirty-checking flushes on commit
            event.touch(now);
            audit.record(
                    admin.uid(),
                    AuditAction.EVENT_UPDATED,
                    TARGET_EVENT,
                    String.valueOf(eventId),
                    Map.of("fields", List.of("capacity"), "capacity", String.valueOf(newCapacity)));
            // The TM-397 seam: an increase frees spots the cascade offers to the waitlist (it polls free
            // spots, so this is picked up on the next sweep — publishing UPDATED is the immediate trigger).
            lifecycle.publishEvent(new EventLifecycleEvent(
                    eventId, event.getHeading(), EventLifecycleEvent.Kind.UPDATED, java.util.Set.of("capacity")));
        }
        return CapacityAdjustResult.of(newCapacity, going, waitlist);
    }

    /**
     * Evict a specific attendee (TM-592): remove their {@code GOING}/{@code WAITLISTED} attendance row,
     * drop them from the event group chat ({@code REMOVED}), notify them, and audit it. Removing a
     * {@code GOING} attendee frees a spot — derived exactly as a self-leave does — so the offer cascade
     * (TM-397) can then offer it FIFO; no auto-promotion happens here. The evicted user is NOT banned and
     * may re-RSVP (which re-inserts at the back of the queue).
     *
     * <p>Idempotent: evicting someone who holds no attendance is a clean no-op (chat/notify skipped) that
     * still records the admin's action (the audit log is append-only). Capacity-locked in the SAME
     * user-then-event order as the RSVP verbs (TM-423): the target's {@code users} row lock first, then
     * the event lock — so this never deadlocks against a concurrent RSVP/claim/cancel on the same
     * user+event, and the freed-spot derivation is race-free.
     *
     * <p><b>Frozen events are rejected (TM-993).</b> A <em>finished</em> event is a {@code 409}
     * ({@code EVENT_ENDED_EDIT}, the same guard {@link #adjustCapacity}/{@link #forceAddAttendee} take) and
     * a <em>cancelled</em> event is a {@code 409} ({@code EVENT_CANCELLED_ROSTER}): both keep attendance as
     * immutable history, and evicting a finished-event GOING row would retroactively unlock the TM-907 name
     * lock (derived live from {@code hasGoingAtFinishedEvent}). The guard runs before any mutation, so the
     * frozen row is never touched.
     *
     * @param targetUserId the {@code users.id} of the attendee to evict — must be an existing account
     */
    @Transactional
    public RosterActionResult evictAttendee(VerifiedUser admin, long eventId, long targetUserId) {
        User target = users.findById(targetUserId).orElseThrow(EventRosterAdminService::userNotFound);
        // User-then-event lock order (TM-423): a concurrent self-cancel/claim by the same target on the
        // same event takes the user lock first too, so evict can't ABBA-deadlock against it.
        users.findByIdForUpdate(targetUserId);
        Instant now = Instant.now();
        Event event = lockedEvent(eventId);
        // TM-993: evict enforces the SAME frozen-event guards its siblings (adjustCapacity / forceAddAttendee)
        // do — otherwise evicting a finished-event GOING row deletes historical attendance and retroactively
        // unlocks the TM-907 name lock (NameLockService derives it live from hasGoingAtFinishedEvent). A
        // finished event is a 409 (mirrors the edit path); a CANCELLED event's kept history is likewise frozen.
        if (phasePolicy.isFinished(event, now)) {
            throw new ConflictException(EventAdminService.EVENT_ENDED_EDIT);
        }
        if (!event.isPublished()) {
            throw new ConflictException(EVENT_CANCELLED_ROSTER);
        }

        Optional<EventAttendance> existing = attendance.findByEventIdAndUserId(eventId, targetUserId);
        AttendanceState removedState = existing.map(EventAttendance::getState).orElse(null);
        if (existing.isPresent()) {
            attendance.deleteByEventIdAndUserId(eventId, targetUserId);
            // Chat sync (TM-446): drop the evicted member from the group thread (REMOVED — the row is kept
            // so a re-RSVP reactivates cleanly; the host is never removed; self-LEFT stays sticky).
            chatLifecycle.onLeave(event, targetUserId);
        }
        long going = attendance.countByEventIdAndState(eventId, AttendanceState.GOING);
        long waitlist = attendance.countByEventIdAndState(eventId, AttendanceState.WAITLISTED);

        audit.record(
                admin.uid(),
                AuditAction.EVENT_ATTENDEE_EVICTED,
                TARGET_EVENT,
                String.valueOf(eventId),
                Map.of(
                        "userId", String.valueOf(targetUserId),
                        "state", removedState == null ? "NONE" : removedState.name()));
        // Notify the evicted user + publish the lifecycle signal only on an actual removal — an idempotent
        // no-op evict doesn't ping someone who was never on the event. The push is deferred to AFTER_COMMIT
        // (TM-730): publishing an EventAttendeeChangedEvent in-tx lets EventLifecycleNotifier fan it out
        // post-commit, off the event lock and pooled connection — never a synchronous FCM round-trip while
        // the SELECT … FOR UPDATE lock is held. Mirrors the EventClaimedEvent seam.
        if (existing.isPresent()) {
            lifecycle.publishEvent(new EventAttendeeChangedEvent(
                    eventId, targetUserId, event.getHeading(), EventAttendeeChangedEvent.Kind.EVICTED));
            lifecycle.publishEvent(new EventLifecycleEvent(
                    eventId, event.getHeading(), EventLifecycleEvent.Kind.UPDATED, java.util.Set.of("roster")));
        }
        return new RosterActionResult(null, going, waitlist);
    }

    /**
     * Force-add a specific existing user as {@code GOING} (TM-592): the target lands {@code GOING}, joins
     * the event group chat, is notified and the action is audited. Target must be an existing account
     * (else {@code 404}).
     *
     * <p><b>Guards (respected BY DEFAULT).</b> Unless {@code override} is set, the add is refused when:
     *
     * <ul>
     *   <li>the event is at/over capacity ({@code 409 EVENT_FULL}) — no oversell;</li>
     *   <li>the target is outside the event's age band ({@link AgeEligibilityPolicy}, {@code 409});</li>
     *   <li>the target already holds a {@code GOING} spot on another live event (the one-active-GOING
     *       rule, {@code 409} naming the blocker).</li>
     * </ul>
     *
     * <p><b>Audited override.</b> {@code override = true} bypasses ALL three guards — the admin explicitly
     * accepts an over-cap add / an out-of-band / double-booked attendee. It is NEVER oversell-unsafe: the
     * write is still under the event {@code SELECT … FOR UPDATE} lock, and the override flag is recorded on
     * the audit row so the bypass is accountable.
     *
     * <p>Idempotent: force-adding a user already {@code GOING} returns their state unchanged (no re-audit
     * of a duplicate). Capacity-locked in user-then-event order (TM-423). A past (finished) event is frozen
     * ({@code 409} {@code EVENT_ENDED_EDIT}, the same guard as the edit path), and a CANCELLED event is
     * frozen too ({@code 409} {@code EVENT_CANCELLED_ROSTER}, TM-967) — neither can be resurrected here,
     * even under {@code override}.
     *
     * @param targetUserId the {@code users.id} of the existing user to add as GOING
     * @param override     bypass capacity + age + one-active-GOING when {@code true} (audited)
     */
    @Transactional
    public RosterActionResult forceAddAttendee(
            VerifiedUser admin, long eventId, long targetUserId, boolean override) {
        User target = users.findById(targetUserId).orElseThrow(EventRosterAdminService::userNotFound);
        // User-then-event lock (TM-423): serialises this target's GOING-landings with any concurrent RSVP
        // /claim they run, so the one-active-GOING guard can't be bypassed by a race and the add is exact.
        users.findByIdForUpdate(targetUserId);
        Instant now = Instant.now();
        Event event = lockedEvent(eventId);
        if (phasePolicy.isFinished(event, now)) {
            throw new ConflictException(EventAdminService.EVENT_ENDED_EDIT);
        }
        // TM-967(a): a CANCELLED event has been called off — force-adding a GOING attendee to it (joining the
        // chat, notifying "you're in") is nonsensical and would mutate a frozen record. Reject with a 409,
        // even under override (a cancelled event, like a finished one, cannot be resurrected via the roster).
        if (!event.isPublished()) {
            throw new ConflictException(EVENT_CANCELLED_ROSTER);
        }

        long going = attendance.countByEventIdAndState(eventId, AttendanceState.GOING);
        long waitlist = attendance.countByEventIdAndState(eventId, AttendanceState.WAITLISTED);

        Optional<EventAttendance> existing = attendance.findByEventIdAndUserId(eventId, targetUserId);
        if (existing.isPresent() && existing.get().getState() == AttendanceState.GOING) {
            return new RosterActionResult(AttendanceState.GOING, going, waitlist); // already GOING — idempotent
        }

        if (!override) {
            if (event.hasCapacityLimit() && going >= event.getCapacity()) {
                throw new ConflictException(EVENT_FULL);
            }
            ageGate.ensureEligible(event, target); // 409 naming the band, or prompt-complete for an unset age
            guardOneActiveEvent(targetUserId, eventId, now);
        }

        // Land the target GOING: either promote their existing WAITLISTED row (keeping its FIFO createdAt)
        // or insert a fresh GOING row. Either way the write is under the event lock, so oversell-safe.
        if (existing.isPresent()) {
            existing.get().promote(); // WAITLISTED -> GOING, offer stamp cleared; dirty-checking flushes
        } else {
            attendance.save(new EventAttendance(eventId, targetUserId, AttendanceState.GOING));
        }
        // Chat sync (TM-446): a GOING landing joins (and lazily creates) the group thread, exactly as an
        // RSVP does. Runs in this locked transaction so membership commits with the attendance write.
        chatLifecycle.onGoing(event, targetUserId);

        long newGoing = attendance.countByEventIdAndState(eventId, AttendanceState.GOING);
        long newWaitlist = attendance.countByEventIdAndState(eventId, AttendanceState.WAITLISTED);

        // Cascade-stop on a last-spot fill (TM-397), mirroring EventRsvpService.claim: if this add just
        // consumed the last free spot, void every other waitlister's live offer so nobody keeps seeing a
        // "spot available to claim" banner for a spot that's gone. Capacity is still enforced under the
        // lock regardless (a stale-offer claim 409s SPOT_ALREADY_TAKEN), so this is a UX cleanup, not a
        // safety fix — but it clears the misleading banner immediately instead of waiting for the next
        // cascade sweep.
        if (event.hasCapacityLimit() && newGoing >= event.getCapacity()) {
            attendance.clearOpenOffers(eventId);
        }

        audit.record(
                admin.uid(),
                AuditAction.EVENT_ATTENDEE_ADDED,
                TARGET_EVENT,
                String.valueOf(eventId),
                Map.of(
                        "userId", String.valueOf(targetUserId),
                        "override", String.valueOf(override)));
        // Deferred push (TM-730): publish in-tx, notify AFTER_COMMIT via EventLifecycleNotifier — never a
        // synchronous FCM fan-out while the event lock and pooled connection are held. Mirrors claim.
        lifecycle.publishEvent(new EventAttendeeChangedEvent(
                eventId, targetUserId, event.getHeading(), EventAttendeeChangedEvent.Kind.ADDED));
        lifecycle.publishEvent(new EventLifecycleEvent(
                eventId, event.getHeading(), EventLifecycleEvent.Kind.UPDATED, java.util.Set.of("roster")));
        return new RosterActionResult(AttendanceState.GOING, newGoing, newWaitlist);
    }

    /**
     * Reuse the RSVP side's "one active event at a time" read (TM-413): refuse the force-add while the
     * target already holds a {@code GOING} attendance to another still-published, unfinished event. Same
     * repository query {@link EventRepository#findActiveGoingForUser} the RSVP verb uses — never
     * re-derived — so the two paths agree on what "blocking" means.
     */
    private void guardOneActiveEvent(long targetUserId, long currentEventId, Instant now) {
        Instant openEndedStartFloor = phasePolicy.openEndedStartFloor(now);
        events.findActiveGoingForUser(targetUserId, currentEventId, now, openEndedStartFloor, PageRequest.of(0, 1))
                .stream()
                .findFirst()
                .ifPresent(blocking -> {
                    throw new ConflictException(activeEventBlock(blocking.getHeading()));
                });
    }

    /** Load the event under the {@code FOR UPDATE} lock; a missing/soft-deleted row is a plain 404. */
    private Event lockedEvent(long eventId) {
        return events.findByIdForUpdate(eventId).orElseThrow(EventRosterAdminService::notFound);
    }

    private static ResourceNotFoundException notFound() {
        return new ResourceNotFoundException("Event not found.");
    }

    private static ResourceNotFoundException userNotFound() {
        return new ResourceNotFoundException("User not found.");
    }
}
