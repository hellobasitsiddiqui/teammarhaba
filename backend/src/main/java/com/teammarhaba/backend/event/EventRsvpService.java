package com.teammarhaba.backend.event;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.ConflictException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Instant;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The capacity-affecting attendance commands — RSVP, un-RSVP and claim (TM-393).
 *
 * <p><b>Locking discipline</b> — every command runs in its own transaction and starts by taking a
 * {@code SELECT ... FOR UPDATE} lock on the {@code events} row
 * ({@link EventRepository#findByIdForUpdate}). All capacity-affecting writes on one event therefore
 * serialise: counts read under the lock are exact, oversell is impossible, and concurrent claims
 * resolve strictly first-come-first-served (first-claim-wins). Contention is per event — commands
 * on different events never queue behind each other.
 *
 * <p>The GOING-landing commands (RSVP, claim) additionally take a {@code SELECT ... FOR UPDATE}
 * lock on the caller's own {@code users} row <em>before</em> the event lock (TM-423), serialising a
 * single user's GOING-landings so the "one active event" guard below can't be bypassed by concurrent
 * landings on two <em>different</em> events (each locks only its own event row, so without this they
 * never mutually exclude). User-then-event lock order is consistent across every command, so there is
 * no deadlock; {@code cancelRsvp} (leaving is never gated) takes no user lock.
 *
 * <p><b>Offer-cascade policy (owner decision 2026-07-03, supersedes auto-promotion)</b> — when a
 * {@code GOING} spot frees, nobody is promoted automatically. The freed spot is <em>recorded</em>
 * purely by derivation (free spots = {@code capacity − GOING count}; see {@code V13}); TM-397
 * polls that condition, notifies waitlisted members in FIFO order five minutes apart (stamping
 * {@code offer_notified_at}), and the spot goes to whichever waitlisted member
 * {@linkplain #claim(VerifiedUser, Long) claims} first. Claiming never requires having been
 * notified — the 5-minute spacing gives earlier queue members a head start, but a later member who
 * learns of the spot may take it (first come, capacity-safe).
 *
 * <p><b>Fairness while a waitlist exists</b> — a new RSVP lands {@code WAITLISTED} whenever the
 * event is at capacity <em>or</em> the waitlist is non-empty, even if a freed spot is technically
 * open. Freed spots belong to the offer cascade; letting a fresh RSVP grab one would let
 * newcomers jump the queue and starve the waitlist forever.
 *
 * <p><b>Change window</b> — all three commands are refused with a {@code 409} once the event has
 * started; hidden events (cancelled, outside the visibility window, soft-deleted) are a public
 * {@code 404} exactly as on the read side.
 *
 * <p><b>Eligibility guards (TM-413)</b> — two further server-side rules gate a <em>new</em> join
 * (RSVP, waitlist-join and claim); leaving is never gated:
 *
 * <ol>
 *   <li><b>Booking cutoff</b> — a join is refused once {@code now >= start − cutoffHours}, where the
 *       cutoff resolves per-event → per-city → app-default (1h) through {@link BookingCutoffPolicy}.
 *       It applies whether the RSVP would land {@code GOING} or {@code WAITLISTED}.</li>
 *   <li><b>One active event at a time</b> — a new {@code GOING} landing (a GOING RSVP or a claim) is
 *       refused with a {@code 409} <em>naming the blocking event</em> while the caller already holds
 *       a {@code GOING} attendance to another still-published, unfinished event. Waitlisting a second
 *       event is allowed — only a {@code GOING} commitment blocks. Leaving the blocker, or the
 *       blocker finishing/being cancelled, frees the caller.</li>
 * </ol>
 * <p><b>Age-group guard (TM-415)</b> — RSVP/waitlist-join and claim additionally enforce
 * {@link AgeEligibilityPolicy}: the caller's self-reported age must fall in the event's band (widened
 * by the app-level ±tolerance grace), else a {@code 409} that names the band — or, for an unset age,
 * prompts profile completion. Leaving ({@link #cancelRsvp}) is never age-gated: a user can always
 * drop out.
 */
@Service
public class EventRsvpService {

    static final String EVENT_NOT_FOUND = "Event not found.";
    static final String EVENT_STARTED = "This event has already started, so attendance can no longer be changed.";
    static final String NOT_ON_WAITLIST = "You are not on the waitlist for this event.";
    static final String SPOT_ALREADY_TAKEN = "That spot has already been taken — you are still on the waitlist.";
    static final String BOOKING_CLOSED =
            "Booking has closed for this event — you can no longer join this close to when it starts.";

    /**
     * The 409 copy for the "one active event at a time" rule, naming the event the caller is still
     * committed to. Exposed (package-private) so tests can assert the exact message.
     */
    static String activeEventBlock(String blockingHeading) {
        return "You're already going to \"" + blockingHeading
                + "\" until it ends — you can only be going to one event at a time. Leave it first to join another.";
    }

    private final EventRepository events;
    private final EventAttendanceRepository attendance;
    private final UserService users;
    private final CancellationPolicy cancellationPolicy;
    private final AgeEligibilityPolicy ageGate;
    private final ApplicationEventPublisher publisher;
    private final BookingCutoffPolicy bookingCutoff;
    private final EventPhasePolicy phasePolicy;
    private final EventChatLifecycleService chatLifecycle;

    public EventRsvpService(
            EventRepository events,
            EventAttendanceRepository attendance,
            UserService users,
            CancellationPolicy cancellationPolicy,
            AgeEligibilityPolicy ageGate,
            ApplicationEventPublisher publisher,
            BookingCutoffPolicy bookingCutoff,
            EventPhasePolicy phasePolicy,
            EventChatLifecycleService chatLifecycle) {
        this.events = events;
        this.attendance = attendance;
        this.users = users;
        this.cancellationPolicy = cancellationPolicy;
        this.ageGate = ageGate;
        this.publisher = publisher;
        this.bookingCutoff = bookingCutoff;
        this.phasePolicy = phasePolicy;
        this.chatLifecycle = chatLifecycle;
    }

    /**
     * RSVP the caller to an event. Capacity-safe under the event lock: lands {@code GOING} while
     * free spots exist <em>and</em> nobody is waitlisted, otherwise {@code WAITLISTED} at the back
     * of the FIFO queue ({@code created_at} is DB-authoritative, so the queue position is the
     * insert order under the lock). Re-RSVPing while already on the event is idempotent — it
     * returns the current state and changes nothing. The caller's account is provisioned
     * just-in-time (as elsewhere), so a brand-new account's first call works.
     */
    @Transactional
    public RsvpResult rsvp(VerifiedUser caller, Long eventId) {
        User user = users.provision(caller);
        users.lockForUpdate(user.getId()); // TM-423: user-row lock serialises this caller's GOING-landings
        Instant now = Instant.now();
        Event event = lockedVisibleEvent(eventId, now);
        if (event.hasStartedBy(now)) {
            throw new ConflictException(EVENT_STARTED);
        }
        if (bookingCutoff.isPastCutoff(event, now)) {
            throw new ConflictException(BOOKING_CLOSED);
        }
        // Hard age-group guard (TM-415): applied to both a fresh RSVP and a waitlist-join (the same
        // command), before the idempotent branch — an ineligible caller gets a uniform 409.
        ageGate.ensureEligible(event, user);

        long going = attendance.countByEventIdAndState(eventId, AttendanceState.GOING);
        long waitlisted = attendance.countByEventIdAndState(eventId, AttendanceState.WAITLISTED);
        return attendance
                .findByEventIdAndUserId(eventId, user.getId())
                .map(existing -> new RsvpResult(existing.getState(), going, waitlisted))
                .orElseGet(() -> {
                    boolean spotFree = !event.hasCapacityLimit() || going < event.getCapacity();
                    AttendanceState state =
                            (spotFree && waitlisted == 0) ? AttendanceState.GOING : AttendanceState.WAITLISTED;
                    if (state == AttendanceState.GOING) {
                        guardOneActiveEvent(user.getId(), eventId, now);
                    }
                    attendance.save(new EventAttendance(eventId, user.getId(), state));
                    // Event-chat lifecycle (TM-446): a GOING landing joins (and lazily creates) the
                    // group thread; a waitlisted landing joins only if the event opts its waitlist into
                    // chat. Runs inside this locked RSVP transaction, so membership commits atomically
                    // with the attendance row.
                    if (state == AttendanceState.GOING) {
                        chatLifecycle.onGoing(event, user.getId());
                    } else {
                        chatLifecycle.onWaitlisted(event, user.getId());
                    }
                    return state == AttendanceState.GOING
                            ? new RsvpResult(state, going + 1, waitlisted)
                            : new RsvpResult(state, going, waitlisted + 1);
                });
    }

    /**
     * Un-RSVP the caller (leave the event), committing the change — see
     * {@link #cancelRsvp(VerifiedUser, Long, boolean)} for the full contract (late-cancellation
     * detection, the strike counter, and the returned message). Equivalent to that method with
     * {@code preview = false}.
     */
    @Transactional
    public CancelResult cancelRsvp(VerifiedUser caller, Long eventId) {
        return cancelRsvp(caller, eventId, false);
    }

    /**
     * Un-RSVP the caller (leave the event) — idempotent: leaving an event you are not on is a
     * quiet no-op. Removing a {@code GOING} attendee frees a spot, and that is the whole
     * "recording" the offer cascade needs: free spots are derived ({@code capacity − GOING count},
     * see {@code V13}), so the moment this transaction commits, TM-397's cascade can see a spot to
     * offer. Deliberately <b>no promotion happens here</b> — waitlisted members stay
     * {@code WAITLISTED} until one of them claims.
     *
     * <p><b>Late cancellation (TM-414)</b> — surrendering a spot you were {@code GOING} to hold,
     * inside the event's cancellation window (resolved event → city → app-default 24h by
     * {@link CancellationPolicy}), is a <em>late cancellation</em>: it increments the caller's
     * running {@code late_cancel_count} in this same transaction and the {@link CancelResult} carries
     * an honest message with the new total. Cancelling earlier — or leaving a {@code WAITLISTED} or
     * absent slot, which surrenders no committed spot — is free and silent (no strike, no message).
     * No consequence is enforced on the count yet; that is the deferred reliability system (TM-409).
     *
     * <p>Pass {@code preview = true} for a non-committing dry-run: it resolves the same verdict and
     * the count the user <em>would</em> reach, writes nothing (no delete, no increment), and returns
     * it — the honest pre-confirm the client shows before the user actually commits.
     */
    @Transactional
    public CancelResult cancelRsvp(VerifiedUser caller, Long eventId, boolean preview) {
        User user = users.provision(caller);
        Instant now = Instant.now();
        Event event = lockedVisibleEvent(eventId, now);
        if (event.hasStartedBy(now)) {
            throw new ConflictException(EVENT_STARTED);
        }

        // A late cancel is giving up a spot you actually HELD (GOING) inside the window. Leaving a
        // WAITLISTED or absent slot surrenders no committed spot, so it never counts as a strike.
        boolean holdingSpot = attendance
                .findByEventIdAndUserId(eventId, user.getId())
                .map(a -> a.getState() == AttendanceState.GOING)
                .orElse(false);
        boolean lateCancel = holdingSpot && cancellationPolicy.isLateCancellation(event, now);

        if (preview) {
            return lateCancel
                    ? CancelResult.previewLate(user.getLateCancelCount() + 1)
                    : CancelResult.free(true, user.getLateCancelCount());
        }

        attendance.deleteByEventIdAndUserId(eventId, user.getId());
        // Event-chat lifecycle (TM-446): leaving the event removes the member from its group thread
        // (a no-op for the host, or someone who was never a chat member). In-transaction, so the
        // membership change commits atomically with the attendance delete.
        chatLifecycle.onLeave(event, user.getId());
        // A committed late cancel bumps the strike counter (dirty-checking flushes on commit).
        return lateCancel
                ? CancelResult.committedLate(user.recordLateCancel())
                : CancelResult.free(false, user.getLateCancelCount());
    }

    /**
     * Claim an open spot from the waitlist — the offer cascade's terminal move (TM-393).
     * Transactional first-claim-wins: under the event lock, the first waitlisted claimer to get
     * here flips to {@code GOING} (their waitlist entry closes, keeping its original
     * {@code createdAt}); every later claimer finds the spot gone and gets a {@code 409} with
     * honest copy. When the claim fills the <em>last</em> free spot, the remaining live offers are
     * {@linkplain EventAttendanceRepository#clearOpenOffers voided} — the recorded cascade-stop
     * signal (TM-397 stops walking, and a future freed spot starts a fresh cascade). A claim by a
     * member who is already {@code GOING} is idempotent (double-tap safe); a claim by someone not
     * on the waitlist at all is a {@code 409}.
     */
    @Transactional
    public RsvpResult claim(VerifiedUser caller, Long eventId) {
        User user = users.provision(caller);
        users.lockForUpdate(user.getId()); // TM-423: user-row lock serialises this caller's GOING-landings
        Instant now = Instant.now();
        Event event = lockedVisibleEvent(eventId, now);
        if (event.hasStartedBy(now)) {
            throw new ConflictException(EVENT_STARTED);
        }
        if (bookingCutoff.isPastCutoff(event, now)) {
            throw new ConflictException(BOOKING_CLOSED);
        }
        // Hard age-group guard (TM-415): a claim is a route into a GOING spot, so it is guarded too —
        // e.g. a member who became ineligible after the admin narrowed the band cannot promote.
        ageGate.ensureEligible(event, user);

        EventAttendance mine = attendance
                .findByEventIdAndUserId(eventId, user.getId())
                .orElseThrow(() -> new ConflictException(NOT_ON_WAITLIST));
        long going = attendance.countByEventIdAndState(eventId, AttendanceState.GOING);
        long waitlisted = attendance.countByEventIdAndState(eventId, AttendanceState.WAITLISTED);
        if (mine.getState() == AttendanceState.GOING) {
            return new RsvpResult(AttendanceState.GOING, going, waitlisted); // double-tap after winning
        }
        if (event.hasCapacityLimit() && going >= event.getCapacity()) {
            throw new ConflictException(SPOT_ALREADY_TAKEN);
        }
        guardOneActiveEvent(user.getId(), eventId, now); // claiming lands GOING — the one-active rule applies

        mine.promote(); // WAITLISTED -> GOING, own offer stamp cleared; dirty-checking flushes on commit
        // Event-chat lifecycle (TM-446): a claim is a WAITLISTED -> GOING landing, so the claimant
        // joins the group thread here — whether or not the event opted its waitlist into chat (a
        // waitlist-in-chat member is already in; ensureMember makes this idempotent).
        chatLifecycle.onGoing(event, user.getId());
        boolean lastSpotFilled = event.hasCapacityLimit() && going + 1 >= event.getCapacity();
        if (lastSpotFilled) {
            attendance.clearOpenOffers(eventId); // cascade-stop signal: void the remaining live offers
        }
        // The offer cascade's terminal signal (TM-397): a genuine WAITLISTED -> GOING promotion (not
        // the double-tap-already-GOING path above) publishes in-transaction, so the "You're in ✓"
        // confirmation push fires from EventLifecycleNotifier only after this claim actually commits.
        // Carry the claim instant so the notifier can scope the durable RSVP_CONFIRMED inbox row to
        // THIS claim episode (TM-555) — a later leave+rejoin+re-claim is a distinct row, not a
        // suppressed duplicate.
        publisher.publishEvent(new EventClaimedEvent(eventId, user.getId(), event.getHeading(), now));
        return new RsvpResult(AttendanceState.GOING, going + 1, waitlisted - 1);
    }

    /**
     * Enforce "one active event at a time" (TM-413): refuse a new {@code GOING} landing while the
     * caller already holds a {@code GOING} attendance to another still-published, unfinished event.
     * The {@code 409} names that blocking event so the client can be honest about why. Called only on
     * the {@code GOING} paths (a GOING RSVP, a claim) — waitlisting is never blocked. Leaving the
     * blocker, or the blocker finishing/being cancelled, clears it (see
     * {@link EventRepository#findActiveGoingForUser}). This is a plain, non-locking read scanning only
     * this caller's own attendance; correctness across two <em>different</em> events under concurrency
     * comes from the caller having taken a {@code SELECT ... FOR UPDATE} lock on their own
     * {@code users} row before this guard ({@link UserService#lockForUpdate}, TM-423), so a single
     * user's GOING-landings serialise and the second sees the first's committed GOING.
     */
    private void guardOneActiveEvent(Long userId, Long currentEventId, Instant now) {
        // Open-ended events (no endAt) stay HAPPENING_NOW until startAt + defaultDuration, so the guard
        // uses that effective end — mirror the listing's openEndedStartFloor rather than clearing at
        // startAt, which would let a user double-book while their open-ended event is still live (TM-404).
        Instant openEndedStartFloor = phasePolicy.openEndedStartFloor(now);
        events.findActiveGoingForUser(userId, currentEventId, now, openEndedStartFloor, PageRequest.of(0, 1))
                .stream()
                .findFirst()
                .ifPresent(blocking -> {
                    throw new ConflictException(activeEventBlock(blocking.getHeading()));
                });
    }

    /**
     * Load the event under the {@code FOR UPDATE} lock and apply the public 404 rule: missing,
     * soft-deleted (never loads), cancelled or outside the visibility window all read as
     * "not found" — hidden events must be indistinguishable from absent ones.
     */
    private Event lockedVisibleEvent(Long eventId, Instant now) {
        Event event = events.findByIdForUpdate(eventId).orElseThrow(() -> new ResourceNotFoundException(
                EVENT_NOT_FOUND));
        if (!event.isVisibleAt(now)) {
            throw new ResourceNotFoundException(EVENT_NOT_FOUND);
        }
        return event;
    }
}
