package com.teammarhaba.backend.membership;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.config.MembershipProperties;
import com.teammarhaba.backend.event.CancelResult;
import com.teammarhaba.backend.event.EventRsvpService;
import com.teammarhaba.backend.event.RsvpResult;
import com.teammarhaba.backend.payments.PaymentOrder;
import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.payments.PaymentProviderException;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.BadRequestException;
import com.teammarhaba.backend.web.ConflictException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityNotFoundException;
import java.time.Instant;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.access.AccessDeniedException;
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

    private static final Logger log = LoggerFactory.getLogger(CheckoutService.class);

    /** The 403 copy when the caller's tier is too low to attend and no per-event charge unlocks it. */
    static final String UPGRADE_TO_ATTEND = "Upgrade your membership to attend this event.";

    /** The 403 copy when the server-side membership flag is off and the checkout would need a payment. */
    static final String PAYMENTS_OFF = "Paid tickets are not available.";

    /** The single currency the paid path charges in — order amounts are defined in GBP pence (V36). */
    private static final String CURRENCY = "GBP";

    private final EntitlementService entitlements;
    private final EventRsvpService rsvps;
    private final MembershipService memberships;
    private final OrderRepository orders;
    private final UserService users;
    private final PaymentProvider payments;
    private final MembershipProperties membershipProps;
    private final EntityManager entityManager;

    public CheckoutService(
            EntitlementService entitlements,
            EventRsvpService rsvps,
            MembershipService memberships,
            OrderRepository orders,
            UserService users,
            PaymentProvider payments,
            MembershipProperties membershipProps,
            EntityManager entityManager) {
        this.entitlements = entitlements;
        this.rsvps = rsvps;
        this.memberships = memberships;
        this.orders = orders;
        this.users = users;
        this.payments = payments;
        this.membershipProps = membershipProps;
        this.entityManager = entityManager;
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
            // Server-side membership flag (TM-623): the PAY branch opens a REAL provider order, so it
            // is 403 while the paid feature is off — the web flag alone left this reachable via curl,
            // falsifying every "unreachable while the flag is off" assumption downstream.
            if (!membershipProps.enabled()) {
                throw new AccessDeniedException(PAYMENTS_OFF);
            }
            // PAY (TM-478): record a PENDING order, then open a REAL payment order with the provider for the
            // amount. Persist the provider's permanent order id on our order (the webhook match key) and
            // return its client token so the browser mounts the checkout widget. The RSVP is NOT created —
            // the caller stays unconfirmed until the payment webhook settles the order.
            //
            // The provider call is inside this transaction (which holds the caller's user-row lock): if it
            // throws — provider down / rejected — the whole checkout rolls back, leaving no orphan PENDING
            // order and no consumed credit. The local order is saved first so its id is the merchant
            // reference passed to the provider for reconciliation.
            Order order =
                    orders.save(new Order(user.getId(), eventId, entitlement.amountPence(), OrderStatus.PENDING, now));
            PaymentOrder providerOrder =
                    payments.createOrder(entitlement.amountPence(), CURRENCY, String.valueOf(order.getId()));
            order.setPaymentReference(payments.name(), providerOrder.id());
            return CheckoutResult.paymentRequired(order, providerOrder.token());
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
     * Settle a PAY checkout on a verified payment webhook (TM-478) — the other half of the PAY path. Moves
     * the local order {@code PENDING → CONFIRMED} and performs the RSVP that {@link #checkout} held back, so
     * the caller is finally confirmed to the event. Reuses the same capacity-safe RSVP write, so every
     * booking-cutoff / age-gate / one-active-event / capacity guard still applies at settle time.
     *
     * <p><strong>Idempotent.</strong> A repeat webhook (Revolut retries, or a double delivery) is a no-op:
     * the caller's user-row lock serialises concurrent deliveries, and {@link Order#confirmPaid} only
     * transitions a still-{@code PENDING} order — an already-{@code CONFIRMED} order (or one reversed by an
     * in-window cancel) confirms nothing and performs no second RSVP. An unknown provider order id (never
     * created here, or from another environment) is silently ignored.
     *
     * <p><strong>A settle for a locally-CANCELLED order is captured money (TM-625).</strong> The
     * cancel-vs-void race: an in-window cancel voids the provider order best-effort, but if the widget
     * payment completed concurrently the void is refused and the money captures anyway. The order is
     * already CANCELLED locally, so this settle buys nothing — the money is owed back: the order is
     * flagged {@code REFUND_DUE} and refunded (retried by the sweeper on failure), never no-opped into
     * a silent keep-the-money.
     *
     * @param providerOrderId the payment provider's permanent order id from the webhook (the match key)
     * @return {@code true} when {@code providerOrderId} resolved to an order in this ledger (whether or
     *         not anything needed doing), {@code false} when it is not an event order — lets the
     *         webhook bridge detect a settled payment that matched NO ledger and flag it loudly.
     */
    @Transactional
    public boolean confirmPayment(String providerOrderId) {
        // Resolve the order once to learn which user to lock, then re-read + REFRESH under that user's
        // lock so a concurrent duplicate delivery serialises and sees the COMMITTED state (the same
        // user-then-event lock ordering as checkout()/cancel(), so the paths can never deadlock). The
        // refresh matters (TM-623): the repository re-query resolves to the same already-managed
        // instance with its pre-lock field values, so without it the confirmPaid idempotency check
        // would evaluate stale state after losing a duplicate-delivery race.
        Long userId =
                orders.findByProviderOrderId(providerOrderId).map(Order::getUserId).orElse(null);
        if (userId == null) {
            return false; // unknown provider order — nothing of ours to confirm (idempotent no-op)
        }
        users.lockForUpdate(userId);

        Order order = orders.findByProviderOrderId(providerOrderId).orElse(null);
        if (order == null) {
            return true; // gone while we waited — ours, but nothing left to confirm
        }
        try {
            entityManager.refresh(order); // committed state, not the stale L1-cache snapshot (TM-623)
        } catch (EntityNotFoundException gone) {
            return true; // row deleted while we waited for the lock
        }
        Instant now = Instant.now();
        if (!order.confirmPaid(now)) {
            // Not PENDING any more. A repeat webhook for a CONFIRMED (or already REFUND_DUE/REFUNDED)
            // order is a plain idempotent no-op — but a settle for a CANCELLED order with real money
            // behind it is the cancel-vs-void race (TM-625): the in-window cancel voided the provider
            // order best-effort, the void was refused because this very payment was completing, and the
            // money is now provably captured for a commitment that no longer exists. Owed back.
            if (order.getStatus() == OrderStatus.CANCELLED
                    && order.getAmountPence() > 0
                    && order.getProviderOrderId() != null) {
                log.warn(
                        "Provider order {} settled AFTER local order {} was cancelled (void refused — "
                                + "the cancel-vs-void race, TM-625): flagging REFUND_DUE and refunding.",
                        providerOrderId,
                        order.getId());
                order.markRefundDue(now);
                tryRefund(order, now);
            }
            return true;
        }

        // Payment settled → perform the held-back RSVP. The caller is Revolut, not a signed-in user, so we
        // load the account provisioned at checkout time by id and drive the already-provisioned RSVP write.
        //
        // Tombstone-safe buyer resolution (TM-625): the buyer may have soft-deleted their account while
        // the widget was open. The restricted getById used to throw OUTSIDE any handling, rolling the
        // whole confirm back — order stranded PENDING, webhook 500-looping forever, captured money with
        // no refund and no flag. A deleted buyer can't attend the event, so the money is owed back:
        // REFUND_DUE + refund, and the webhook is acknowledged.
        User user = users.findAnyById(order.getUserId())
                .filter(account -> !account.isDeleted())
                .orElse(null);
        if (user == null) {
            log.warn(
                    "Paid order {} settled for a deleted/missing account — marking REFUND_DUE and "
                            + "refunding (TM-625).",
                    order.getId());
            order.markRefundDue(now);
            tryRefund(order, now);
            return true;
        }

        // Settle-time guard failure (TM-623): the RSVP guards (event started, booking cutoff, age-gate,
        // one-active-event) can legitimately refuse between checkout and settle. The money is CAPTURED
        // by then — throwing here used to roll the confirm back, stranding the order PENDING forever
        // while Revolut retried the same failing delivery. Instead: keep the payment recorded, mark the
        // order REFUND_DUE (service undeliverable ⇒ money owed back), issue the refund, and return
        // normally so the webhook is acknowledged and the retry loop ends.
        try {
            rsvps.rsvpForConfirmedOrder(user, order.getEventId());
        } catch (ResourceNotFoundException | ConflictException | BadRequestException e) {
            log.warn(
                    "Paid order {} could not be provisioned at settle time ({}) — marking REFUND_DUE "
                            + "and refunding (TM-623).",
                    order.getId(),
                    e.getMessage());
            order.markRefundDue(now);
            tryRefund(order, now);
        }
        return true;
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

        // Reversing a still-PENDING PAY order: void the provider order too (TM-623, best-effort). Its
        // single-use widget token may still be mounted in an open tab — without the void, a payment
        // completed there AFTER this cancel would be captured at the provider and then no-op locally
        // (confirmPaid refuses a non-PENDING order): money taken, no attendance, no reconciliation.
        if (order.getStatus() == OrderStatus.PENDING && order.getProviderOrderId() != null) {
            try {
                payments.cancelOrder(order.getProviderOrderId());
            } catch (PaymentProviderException e) {
                log.warn(
                        "Could not void provider order {} while cancelling order {} — reconcile it "
                                + "manually if it is ever paid.",
                        order.getProviderOrderId(),
                        order.getId(),
                        e);
            }
        }

        order.reverse(now); // CONFIRMED + real money -> REFUND_DUE, else -> CANCELLED; flushes on commit

        // REFUND_DUE now has a real execution path (TM-623): issue the provider refund immediately.
        // On failure the order simply STAYS REFUND_DUE — the debt remains visible and retryable.
        if (order.getStatus() == OrderStatus.REFUND_DUE) {
            tryRefund(order, now);
        }
        return CheckoutCancelResult.of(true, creditReturned, cancel, order);
    }

    /**
     * Issue the provider refund a {@code REFUND_DUE} order owes (TM-623), best-effort: success moves the
     * order to {@code REFUNDED} (terminal — the money is back); failure logs and leaves it
     * {@code REFUND_DUE} so nothing about the debt is lost — the scheduled {@link RefundSweepService}
     * (TM-625) picks the row up and retries the refund until it succeeds.
     * Never throws — a refund hiccup must not roll back the surrounding cancel/confirm bookkeeping.
     */
    private void tryRefund(Order order, Instant now) {
        if (order.getProviderOrderId() == null || order.getAmountPence() <= 0) {
            // No captured provider payment behind this order (defensive) — nothing to return.
            order.markRefunded(now);
            return;
        }
        try {
            payments.refund(
                    order.getProviderOrderId(), order.getAmountPence(), CURRENCY, String.valueOf(order.getId()));
            order.markRefunded(now);
        } catch (PaymentProviderException e) {
            log.warn(
                    "Refund of order {} (provider order {}) failed — order stays REFUND_DUE for retry.",
                    order.getId(),
                    order.getProviderOrderId(),
                    e);
        }
    }
}
