package com.teammarhaba.backend.membership;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.CancelResult;
import com.teammarhaba.backend.event.EventRsvpService;
import com.teammarhaba.backend.event.RsvpResult;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import java.time.Instant;
import java.util.Optional;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * RSVP checkout + order record (TM-477). RSVP goes through a checkout that resolves the caller's
 * entitlement (reusing TM-476's {@link EntitlementService}/{@code EntitlementResolver} — the tier rules
 * are never re-derived here) and records an {@link Order} — the durable receipt of the commitment.
 *
 * <p><strong>The four paths.</strong>
 *
 * <ul>
 *   <li><b>FREE / INCLUDED</b> — frictionless: no payment, a £0 {@link OrderStatus#CONFIRMED} order, and
 *       the actual RSVP is performed (reusing {@link EventRsvpService#rsvp}, so every capacity/eligibility
 *       guard still applies). On a first-event {@code FREE} (reason {@link EntitlementReason#FIRST_EVENT_FREE}
 *       — <em>not</em> a genuinely free event or a tier-included one), the credit is consumed on
 *       commitment. RSVP confirms.</li>
 *   <li><b>PAY</b> — a {@link OrderStatus#PENDING} order for the amount and "payment required"; the charge
 *       is <em>stubbed</em> (the Revolut integration is TM-478). No RSVP is created — the caller stays
 *       unconfirmed until payment settles.</li>
 *   <li><b>UPGRADE</b> — a {@code 403} via {@link UpgradeRequiredException}. No current rule produces it
 *       (see TM-476), but it is handled so the reserved contract value has a defined behaviour.</li>
 * </ul>
 *
 * <p><strong>Idempotent per (user, event).</strong> A repeat checkout returns the existing order rather
 * than a duplicate — enforced by the {@code UNIQUE (user_id, event_id)} on {@code orders} and made
 * race-free by the caller's {@code SELECT ... FOR UPDATE} user-row lock ({@link UserService#lockForUpdate},
 * taken first): a concurrent second checkout serialises behind the first and sees its committed order.
 *
 * <p><strong>Atomic credit consumption.</strong> The credit consume (or reverse) and the order write share
 * this one transaction, so a race can never double-spend the credit or leave it consumed with no order:
 * either the whole commitment commits, or none of it does.
 *
 * <p><strong>Cancel / reverse.</strong> {@link #cancel} drops the attendance (leaving is never gated) and,
 * <em>inside the cancellation window</em> (per-event, default 24h before start — the exact TM-414
 * computation, reused via {@link EventRsvpService#cancelRsvp}'s {@code lateCancel} verdict), reverses the
 * commitment: it returns the first-event credit (if this event consumed it) and moves the order to
 * {@link OrderStatus#CANCELLED} / {@link OrderStatus#REFUND_DUE}. The actual money refund is TM-478's job.
 * Missing the window (a late cancel, or a no-show) forfeits the credit/charge even though the caller leaves.
 */
@Service
public class CheckoutService {

    /** The 403 copy when the caller's tier is too low to attend and no per-event charge unlocks it. */
    static final String UPGRADE_TO_ATTEND = "Upgrade your membership to attend this event.";

    private final EntitlementService entitlements;
    private final EventRsvpService rsvps;
    private final MembershipService memberships;
    private final OrderRepository orders;
    private final UserService users;

    public CheckoutService(
            EntitlementService entitlements,
            EventRsvpService rsvps,
            MembershipService memberships,
            OrderRepository orders,
            UserService users) {
        this.entitlements = entitlements;
        this.rsvps = rsvps;
        this.memberships = memberships;
        this.orders = orders;
        this.users = users;
    }

    /**
     * Check out an RSVP for {@code caller} against {@code eventId} (TM-477). Resolves the entitlement,
     * then records the order and (for a frictionless confirm) performs the RSVP — see the class Javadoc
     * for the full path table. A hidden/missing event is a {@code 404} (from the resolver); an
     * {@code UPGRADE} entitlement is a {@code 403}. Idempotent per (user, event).
     */
    @Transactional
    public CheckoutResult checkout(VerifiedUser caller, Long eventId) {
        User user = users.provision(caller);
        // Serialise this caller's checkouts (TM-423 pattern): the idempotency read below then sees any
        // concurrent first checkout's committed order, and the credit consume can't race itself.
        users.lockForUpdate(user.getId());
        Instant now = Instant.now();

        // Reuse the TM-476 resolver — never re-derive the tier rules. 404s a hidden/missing event, and
        // JIT-enrols a brand-new membership, exactly as GET /events/{id}/entitlement does.
        Entitlement entitlement = entitlements.resolve(caller, eventId);

        if (entitlement.decision() == EntitlementDecision.UPGRADE) {
            throw new UpgradeRequiredException(UPGRADE_TO_ATTEND);
        }

        // Idempotent per (user, event): a repeat checkout returns the existing order, never a duplicate.
        Optional<Order> existing = orders.findByUserIdAndEventId(user.getId(), eventId);
        if (existing.isPresent()) {
            return CheckoutResult.existing(existing.get());
        }

        if (entitlement.decision() == EntitlementDecision.PAY) {
            // Charge STUBBED here — the Revolut integration is TM-478. Record a PENDING order for the
            // amount and return "payment required"; the RSVP is NOT created, so the caller stays
            // unconfirmed until payment settles.
            Order order =
                    orders.save(new Order(user.getId(), eventId, entitlement.amountPence(), OrderStatus.PENDING, now));
            return CheckoutResult.paymentRequired(order);
        }

        // FREE / INCLUDED -> frictionless confirm. Do the real RSVP first (all capacity/eligibility guards
        // apply); if it throws — booking closed, age-gate, one-active-event — the whole checkout rolls
        // back, so no order is left behind and no credit is consumed.
        RsvpResult rsvp = rsvps.rsvp(caller, eventId);

        // Consume the first-event credit ONLY on a genuine first-event FREE (reason FIRST_EVENT_FREE) — a
        // £0 event (FREE_EVENT) or a tier-included event consumes nothing. Done on the managed membership
        // in THIS transaction, atomically with the order write below.
        if (entitlement.reason() == EntitlementReason.FIRST_EVENT_FREE) {
            memberships.getOrEnrol(caller).consumeFirstEventCredit(eventId, now);
        }

        Order order =
                orders.save(new Order(user.getId(), eventId, entitlement.amountPence(), OrderStatus.CONFIRMED, now));
        return CheckoutResult.confirmed(order, rsvp);
    }

    /**
     * Cancel a checkout for {@code caller} against {@code eventId} (TM-477). Always drops the attendance
     * (reusing {@link EventRsvpService#cancelRsvp}, which also 409s once the event has started and yields
     * the {@code lateCancel} window verdict). Inside the cancellation window it reverses the commitment —
     * returns the first-event credit (if this event consumed it) and moves the order to
     * {@code CANCELLED}/{@code REFUND_DUE}; outside it, the credit/charge is forfeited. Idempotent: an
     * already-reversed order (or no order at all) leaves the commitment untouched.
     */
    @Transactional
    public CheckoutCancelResult cancel(VerifiedUser caller, Long eventId) {
        User user = users.provision(caller);
        users.lockForUpdate(user.getId()); // consistent user-then-event lock order; serialises the reverse
        Instant now = Instant.now();

        // Drop the attendance and get the window verdict in one place (TM-414): lateCancel == true means
        // we are PAST the refundable cut-off (inside the final window before start) -> forfeit; false
        // means an early cancel -> reversible. Also 409s if the event has already started.
        CancelResult cancel = rsvps.cancelRsvp(caller, eventId, false);

        Order order = orders.findByUserIdAndEventId(user.getId(), eventId).orElse(null);
        if (order == null || !order.isReversible()) {
            // No checkout order, or already cancelled/refunded — nothing to reverse (idempotent).
            return CheckoutCancelResult.of(false, false, cancel, order);
        }
        if (cancel.lateCancel()) {
            // Missed the window: consumed/forfeited even though the caller left the event. Order untouched.
            return CheckoutCancelResult.of(false, false, cancel, order);
        }

        // Inside the window: reverse the commitment. Return the first-event credit only if THIS event is
        // the one that consumed it (the membership points at exactly one event), then flip the order.
        Membership membership = memberships.getOrEnrol(caller);
        boolean creditReturned =
                membership.isFirstEventCreditUsed() && eventId.equals(membership.getFirstEventCreditEventId());
        if (creditReturned) {
            membership.reverseFirstEventCredit(now);
        }
        order.reverse(now); // CONFIRMED + real money -> REFUND_DUE, else -> CANCELLED; flushes on commit
        return CheckoutCancelResult.of(true, creditReturned, cancel, order);
    }
}
