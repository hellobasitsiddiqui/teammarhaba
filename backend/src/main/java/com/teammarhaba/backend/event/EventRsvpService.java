package com.teammarhaba.backend.event;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.config.MembershipProperties;
import com.teammarhaba.backend.membership.Entitlement;
import com.teammarhaba.backend.membership.EntitlementDecision;
import com.teammarhaba.backend.membership.EntitlementReason;
import com.teammarhaba.backend.membership.EntitlementService;
import com.teammarhaba.backend.membership.MembershipService;
import com.teammarhaba.backend.membership.OrderRepository;
import com.teammarhaba.backend.membership.OrderStatus;
import com.teammarhaba.backend.membership.PaymentRequiredException;
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
 *
 * <p><b>Paid-event join gate (TM-625)</b> — while the server-side membership flag
 * ({@code app.membership.enabled}, TM-623) is on, a <em>new</em> landing via the direct verbs (a fresh
 * RSVP/waitlist-join, or a claim) on an event whose entitlement resolves to {@code PAY} is refused
 * with a {@code 402 Payment Required} unless the caller already holds a settled ({@code CONFIRMED})
 * order for it — the join must go through checkout (TM-477/478) so the money settles first. Without
 * this, any authenticated caller could free-join a priced/premium event, bypassing the checkout PAY
 * gate entirely. {@code FREE}/{@code INCLUDED} entitlements join normally — and a {@code FREE} landing
 * granted by the <em>first-event credit</em> consumes that credit on commitment (TM-629), exactly as
 * checkout does, so the freebie cannot be re-used event after event through the direct verbs. The
 * webhook-driven {@link #rsvpForConfirmedOrder} path (money already settled) is never re-gated;
 * idempotent re-RSVPs/double-tap claims and leaving are untouched; and with the flag <em>off</em> no
 * entitlement is resolved at all — the verbs keep their exact legacy behaviour.
 */
@Service
public class EventRsvpService {

    static final String EVENT_NOT_FOUND = "Event not found.";
    static final String EVENT_STARTED = "This event has already started, so attendance can no longer be changed.";
    static final String NOT_ON_WAITLIST = "You are not on the waitlist for this event.";
    static final String SPOT_ALREADY_TAKEN = "That spot has already been taken — you are still on the waitlist.";
    static final String BOOKING_CLOSED =
            "Booking has closed for this event — you can no longer join this close to when it starts.";
    static final String PAYMENT_REQUIRED =
            "This event requires payment — complete checkout to book your spot.";
    static final String RELIABILITY_DOWNGRADED =
            "Your account is temporarily limited to the waitlist for capacity-limited events after "
                    + "repeated late cancellations — you can still join events without a capacity limit.";

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
    private final MembershipProperties membershipProps;
    private final EntitlementService entitlements;
    private final OrderRepository orders;
    private final MembershipService memberships;
    private final ReliabilityService reliability;

    public EventRsvpService(
            EventRepository events,
            EventAttendanceRepository attendance,
            UserService users,
            CancellationPolicy cancellationPolicy,
            AgeEligibilityPolicy ageGate,
            ApplicationEventPublisher publisher,
            BookingCutoffPolicy bookingCutoff,
            EventPhasePolicy phasePolicy,
            EventChatLifecycleService chatLifecycle,
            MembershipProperties membershipProps,
            EntitlementService entitlements,
            OrderRepository orders,
            MembershipService memberships,
            ReliabilityService reliability) {
        this.events = events;
        this.attendance = attendance;
        this.users = users;
        this.cancellationPolicy = cancellationPolicy;
        this.ageGate = ageGate;
        this.publisher = publisher;
        this.bookingCutoff = bookingCutoff;
        this.phasePolicy = phasePolicy;
        this.chatLifecycle = chatLifecycle;
        this.membershipProps = membershipProps;
        this.entitlements = entitlements;
        this.orders = orders;
        this.memberships = memberships;
        this.reliability = reliability;
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
        // Provision the caller from their verified token, then run the shared capacity-safe write.
        // Passing the caller marks this a DIRECT join, subject to the TM-625 paid-event gate.
        return rsvpProvisioned(users.provision(caller), eventId, caller);
    }

    /**
     * RSVP an <em>already-provisioned</em> user (TM-478 payment confirm) — the identical capacity-safe
     * write as {@link #rsvp(VerifiedUser, Long)}, for a caller resolved by id rather than a Firebase token.
     * The payment webhook has no {@link VerifiedUser} (the caller is the payment provider, not the user),
     * so {@code CheckoutService.confirmPayment} loads the account provisioned at checkout time and drives
     * the RSVP that PAY held back until the money settled. Joins the confirm's transaction (propagation
     * REQUIRED) so the order-confirm and the RSVP commit atomically.
     */
    @Transactional
    public RsvpResult rsvpForConfirmedOrder(User user, Long eventId) {
        // No direct caller: this join is backed by a settled order, so the TM-625 gate never re-fires.
        return rsvpProvisioned(user, eventId, null);
    }

    /**
     * The shared capacity-safe RSVP write for a provisioned {@code user} — see {@link #rsvp} for contract.
     * {@code directCaller} is the verified caller on the direct-verb path (subject to the TM-625
     * paid-event gate) and {@code null} on the confirmed-order path (money settled — never re-gated).
     */
    private RsvpResult rsvpProvisioned(User user, Long eventId, VerifiedUser directCaller) {
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
                    // Paid-event join gate (TM-625): only a NEW landing is gated — the idempotent
                    // re-RSVP branch above returns the existing state without ever resolving an
                    // entitlement, and every pre-existing guard (404/started/cutoff/age) keeps its
                    // precedence because the gate runs last, just before the attendance write.
                    Entitlement entitlement = guardPaidEventJoin(directCaller, user, eventId);
                    boolean spotFree = !event.hasCapacityLimit() || going < event.getCapacity();
                    AttendanceState state =
                            (spotFree && waitlisted == 0) ? AttendanceState.GOING : AttendanceState.WAITLISTED;
                    if (state == AttendanceState.GOING) {
                        // Reliability downgrade (TM-409): a downgraded account can't grab a GOING spot on
                        // a capacity-limited event — checked only on the GOING landing, so a downgraded
                        // user can still join the waitlist of a full event (the "waitlist-only" limit).
                        guardReliabilityDowngrade(directCaller, user, event);
                        guardOneActiveEvent(user.getId(), eventId, now);
                    }
                    attendance.save(new EventAttendance(eventId, user.getId(), state));
                    // A FREE-first direct landing is a COMMITMENT, so it spends the one first-event
                    // credit (TM-629) — exactly as checkout does. Without this, the direct verb read
                    // the FIRST_EVENT_FREE entitlement but never consumed it, so a pay-per-event
                    // caller could free-join priced events repeatedly, never routing through checkout.
                    consumeFirstEventCreditOnCommitment(directCaller, entitlement, eventId, now);
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
     * running {@code late_cancel_count} in this same transaction, appends a reliability ledger row
     * ({@link ReliabilityService}, TM-409) and the {@link CancelResult} carries an honest message with
     * the new total, the points it cost and the account's resulting standing. Cancelling earlier — or
     * leaving a {@code WAITLISTED} or absent slot, which surrenders no committed spot — is free and
     * silent (no strike, no message). The strike now carries a consequence: once the count reaches the
     * configured downgrade threshold the account is limited to the waitlist for capacity-limited events
     * (enforced at RSVP/claim, TM-409).
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
            // Pre-confirm (TM-409): the transparent "cancelling now costs X points; you're at Y". The
            // reliability standing is the one the strike WOULD reach; nothing is written on a dry-run.
            if (lateCancel) {
                int wouldBeCount = user.getLateCancelCount() + 1;
                return CancelResult.previewLate(
                        wouldBeCount, reliability.penaltyPoints(), reliability.statusFor(wouldBeCount));
            }
            return CancelResult.free(true, user.getLateCancelCount(), reliability.statusFor(user.getLateCancelCount()));
        }

        attendance.deleteByEventIdAndUserId(eventId, user.getId());
        // Event-chat lifecycle (TM-446): leaving the event removes the member from its group thread
        // (a no-op for the host, or someone who was never a chat member). In-transaction, so the
        // membership change commits atomically with the attendance delete.
        chatLifecycle.onLeave(event, user.getId());
        // A committed late cancel bumps the strike counter AND appends a reliability ledger row (TM-409),
        // both inside this transaction (dirty-checking + the audit write flush on commit). A free cancel
        // still reports the account's current standing so the client can keep its banner in step.
        if (lateCancel) {
            int newCount = reliability.recordLateCancel(user, eventId);
            return CancelResult.committedLate(newCount, reliability.penaltyPoints(), reliability.statusFor(newCount));
        }
        return CancelResult.free(false, user.getLateCancelCount(), reliability.statusFor(user.getLateCancelCount()));
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
        // Paid-event join gate (TM-625): a claim is a route into a GOING spot, so it is gated exactly
        // like a fresh RSVP — otherwise a free waitlist landing could be promoted into a paid event
        // without ever paying. A paid-up member (their CONFIRMED order landed them WAITLISTED via the
        // payment webhook when the event was full) passes: their money already settled.
        Entitlement entitlement = guardPaidEventJoin(caller, user, eventId);
        // Reliability downgrade (TM-409): a claim promotes WAITLISTED -> GOING on a capacity-limited
        // event, so a downgraded account is blocked here exactly as it is on a fresh GOING RSVP —
        // otherwise the waitlist-only limit would be trivially bypassed by claiming a freed spot.
        guardReliabilityDowngrade(caller, user, event);
        guardOneActiveEvent(user.getId(), eventId, now); // claiming lands GOING — the one-active rule applies

        mine.promote(); // WAITLISTED -> GOING, own offer stamp cleared; dirty-checking flushes on commit
        // A FREE-first claim spends the credit too (TM-629) — normally a no-op re-stamp, because the
        // waitlist landing already consumed it for this same event; it only bites for a legacy
        // waitlist row that predates consumption on the RSVP verb.
        consumeFirstEventCreditOnCommitment(caller, entitlement, eventId, now);
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
     * The paid-event join gate (TM-625): refuse a direct join (a fresh RSVP/waitlist-join, or a claim)
     * when the event actually costs the caller money they have not paid. Closes the residual deploy
     * blocker from the TM-623 re-verify — the checkout PAY branch was gated, but these free verbs let
     * any authenticated caller land {@code GOING} on a priced/premium event with no order and no payment.
     *
     * <ul>
     *   <li><b>Flag off ({@code app.membership.enabled=false})</b> — the paid feature does not exist:
     *       no entitlement is resolved, no gate; the verbs behave exactly as before TM-625.</li>
     *   <li><b>Confirmed-order path ({@code directCaller == null})</b> — the payment webhook drives
     *       {@link #rsvpForConfirmedOrder} after the money settles; re-gating it would deadlock the
     *       paid flow, so it is exempt by construction.</li>
     *   <li><b>{@code FREE} / {@code INCLUDED}</b> — no charge stands in the way; the join proceeds.
     *       (Reusing {@link EntitlementService} — the tier x event rules are never re-derived here.)</li>
     *   <li><b>{@code PAY} (and the reserved {@code UPGRADE})</b> — refused with a {@code 402} unless
     *       the caller holds a settled ({@code CONFIRMED}) order for this event. The order check keeps
     *       the paid waitlist flow working: a member whose paid RSVP landed {@code WAITLISTED} must
     *       still be able to {@linkplain #claim claim} a freed spot, and a paid member's re-RSVP stays
     *       idempotent rather than demanding a second payment.</li>
     * </ul>
     *
     * <p>Runs inside the command's transaction, after every pre-existing guard, immediately before the
     * attendance write — so no existing 404/409 outcome changes precedence, and the entitlement read
     * (which may JIT-enrol a membership, exactly as checkout does) shares the surrounding locks.
     *
     * @return the resolved entitlement when the gate ran (so the caller can consume a
     *         {@code FIRST_EVENT_FREE} credit on commitment, TM-629), or {@code null} when no
     *         entitlement was resolved (settled-order path / flag off)
     */
    private Entitlement guardPaidEventJoin(VerifiedUser directCaller, User user, Long eventId) {
        if (directCaller == null || !membershipProps.enabled()) {
            return null; // settled-order path, or the paid feature is off — legacy behaviour, no resolution
        }
        Entitlement entitlement = entitlements.resolve(directCaller, eventId);
        EntitlementDecision decision = entitlement.decision();
        if (decision == EntitlementDecision.FREE || decision == EntitlementDecision.INCLUDED) {
            return entitlement; // nothing to pay — the direct join is legitimate
        }
        // PAY (or reserved UPGRADE): only a settled order proves the money side is done. PENDING /
        // CANCELLED / REFUND_DUE / REFUNDED orders do not buy a join — the money never (or no longer)
        // covers this event.
        boolean settled = orders.findByUserIdAndEventId(user.getId(), eventId)
                .map(order -> order.getStatus() == OrderStatus.CONFIRMED)
                .orElse(false);
        if (!settled) {
            throw new PaymentRequiredException(PAYMENT_REQUIRED);
        }
        return entitlement;
    }

    /**
     * Spend the caller's one first-event credit when a direct join committed on the strength of it
     * (TM-629) — the same "consumed on commitment" rule checkout applies (TM-477), now shared by the
     * direct RSVP/waitlist-join and claim verbs. Before this, the direct verbs only <em>read</em> the
     * {@code FIRST_EVENT_FREE} entitlement: the credit stayed available, so it could be re-used for
     * event after event without ever going through checkout (the TM-625a free-credit abuse).
     *
     * <p>No-op unless the gate actually resolved a {@code FIRST_EVENT_FREE} entitlement for a direct
     * caller. Re-consuming for the SAME event (a claim after the waitlist landing consumed, or a
     * checkout following a direct join) just re-stamps identical values — {@code EntitlementService}
     * keeps that event's entitlement {@code FIRST_EVENT_FREE}, and {@code CheckoutService.cancel}
     * returns the credit on an in-window cancel exactly as for a checkout-consumed credit.
     */
    private void consumeFirstEventCreditOnCommitment(
            VerifiedUser directCaller, Entitlement entitlement, Long eventId, Instant now) {
        if (directCaller == null || entitlement == null || entitlement.reason() != EntitlementReason.FIRST_EVENT_FREE) {
            return;
        }
        memberships.getOrEnrol(directCaller).consumeFirstEventCredit(eventId, now);
    }

    /**
     * Enforce the reliability downgrade (TM-409): refuse a {@code GOING} landing on a
     * <em>capacity-limited</em> event by a downgraded account, restricting it to the waitlist. The
     * account is downgraded once its running late-cancellation strike count reaches the configured
     * {@code downgradeThreshold} ({@link ReliabilityService}/{@code ReliabilityPolicy}); the {@code 409}
     * copy is honest about why and points out non-capacity-limited events remain open.
     *
     * <ul>
     *   <li><b>Direct joins only</b> — the settled-order path ({@code directCaller == null}) is never
     *       re-gated, exactly like the paid-event gate: the money settled, the landing must complete.</li>
     *   <li><b>Capacity-limited only</b> — an unlimited event has no scarce GOING spot to protect, so a
     *       downgraded account joins it normally.</li>
     *   <li><b>Feature off</b> — {@link ReliabilityService#isDowngraded} is always {@code false}, so the
     *       gate is inert and behaviour is exactly as before TM-409.</li>
     * </ul>
     */
    private void guardReliabilityDowngrade(VerifiedUser directCaller, User user, Event event) {
        if (directCaller == null || !event.hasCapacityLimit()) {
            return; // settled-order path, or no scarce spot to protect — no reliability gate
        }
        if (reliability.isDowngraded(user.getLateCancelCount())) {
            throw new ConflictException(RELIABILITY_DOWNGRADED);
        }
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
