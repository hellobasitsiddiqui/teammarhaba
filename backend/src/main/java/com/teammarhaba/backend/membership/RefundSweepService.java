package com.teammarhaba.backend.membership;

import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.payments.PaymentProviderException;
import com.teammarhaba.backend.user.UserService;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityNotFoundException;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The {@code REFUND_DUE} retry sweep (TM-625): finds every order / subscription charge stuck owing the
 * customer money — a refund attempt that failed at issue time (provider 5xx, timeout), or a row flagged
 * before any live path could execute the refund — and retries the provider refund until it succeeds.
 * Driven by {@link RefundSweepScheduler}'s fixed-delay tick; all the logic lives here so tests exercise
 * it directly and deterministically (the same heartbeat/service split as
 * {@code SubscriptionRenewalScheduler} / {@link SubscriptionRenewalService}).
 *
 * <p><strong>Why this exists.</strong> {@code REFUND_DUE} used to be a dead-end (TM-625): the inline
 * refund paths ({@code CheckoutService.tryRefund}, {@code SubscriptionService}'s superseded-settle
 * refund) swallow a provider failure by design — the surrounding cancel/confirm bookkeeping must stand
 * — but nothing ever came back for the row. A single transient gateway hiccup meant captured money owed
 * back FOREVER with no operation able to return it. This sweep is that missing operation: the flag is
 * now a work queue, not a label.
 *
 * <p><strong>Money direction makes retries safe.</strong> A refund moves money back TO the customer
 * against a specific captured provider order; the provider executes at most one full refund per order,
 * so re-attempting after an ambiguous failure can never over-refund — the same gateway-side idempotency
 * argument the renewal engine relies on for charges, pointing the other way.
 *
 * <p><strong>Soft-deleted buyers are still refunded.</strong> The money goes back to the card, not the
 * account, so a tombstoned buyer's {@code REFUND_DUE} rows are swept like any other (the user-row lock
 * is best-effort — it silently no-ops for a soft-deleted user, and the {@code @Version} column backstops
 * the local bookkeeping).
 *
 * <p><strong>Concurrency.</strong> Each row is processed in its OWN transaction (one poisoned row can't
 * fail the pass), re-read fresh ({@code EntityManager.refresh}) under the owner's user-row lock so a
 * webhook confirm or a user cancel racing the sweep serialises instead of double-driving the same order.
 * Any number of instances may tick.
 */
@Service
public class RefundSweepService {

    private static final Logger log = LoggerFactory.getLogger(RefundSweepService.class);

    /** Upper bound on rows handled per pass per ledger (oldest first; the next tick takes the rest). */
    private static final int SCAN_LIMIT = 100;

    /**
     * Retry budget for one {@code REFUND_DUE} row (TM-726). After this many FAILED sweep attempts the row
     * is moved to the terminal {@code REFUND_ABANDONED} state instead of being retried forever — a refund
     * still failing after this many hourly passes is permanently rejected (already refunded out of band,
     * too old, wrong amount) and needs a human, not another identical retry.
     */
    static final int MAX_REFUND_ATTEMPTS = 24;

    private final OrderRepository orders;
    private final SubscriptionChargeRepository charges;
    private final UserService users;
    private final PaymentProvider payments;
    private final EntityManager entityManager;

    public RefundSweepService(
            OrderRepository orders,
            SubscriptionChargeRepository charges,
            UserService users,
            PaymentProvider payments,
            EntityManager entityManager) {
        this.orders = orders;
        this.charges = charges;
        this.users = users;
        this.payments = payments;
        this.entityManager = entityManager;
    }

    /** The event-ticket orders currently owing a refund (oldest first, bounded). Ids only. */
    @Transactional(readOnly = true)
    public List<Long> findRefundDueOrderIds() {
        return orders.findByStatusOrderByIdAsc(OrderStatus.REFUND_DUE, PageRequest.of(0, SCAN_LIMIT)).stream()
                .map(Order::getId)
                .toList();
    }

    /** The subscription charges currently owing a refund (oldest first, bounded). Ids only. */
    @Transactional(readOnly = true)
    public List<Long> findRefundDueChargeIds() {
        return charges
                .findByStatusOrderByIdAsc(SubscriptionCharge.Status.REFUND_DUE, PageRequest.of(0, SCAN_LIMIT))
                .stream()
                .map(SubscriptionCharge::getId)
                .toList();
    }

    /**
     * Retry the refund one {@code REFUND_DUE} order owes, in its own transaction under the buyer's
     * user-row lock. Success is terminal ({@code REFUNDED}); failure leaves the row {@code REFUND_DUE}
     * for the next pass — the debt is never lost, only deferred — UNTIL the {@link #MAX_REFUND_ATTEMPTS}
     * retry budget is exhausted, when the row moves to the terminal {@code REFUND_ABANDONED} for manual
     * reconciliation so a permanently-rejected refund is not retried forever (TM-726).
     *
     * @return {@code true} when the row was resolved (refunded, or defensively closed), {@code false}
     *         for a no-longer-due no-op or a still-failing refund (retried next tick)
     */
    @Transactional
    public boolean processOrder(Long orderId) {
        Order order = orders.findById(orderId).orElse(null);
        if (order == null || order.getStatus() != OrderStatus.REFUND_DUE) {
            return false; // resolved between the scan and here — nothing to do
        }
        // Serialise with webhook confirms / cancels on this buyer (best-effort: no-ops when the buyer
        // is soft-deleted — the refresh + status re-check below still make the sweep race-safe).
        users.lockForUpdate(order.getUserId());
        try {
            entityManager.refresh(order); // committed state, not the stale L1-cache snapshot (TM-623)
        } catch (EntityNotFoundException gone) {
            return false; // row deleted while we waited for the lock
        }
        if (order.getStatus() != OrderStatus.REFUND_DUE) {
            return false; // whoever held the lock before us already resolved it
        }
        Instant now = Instant.now();
        if (order.getProviderOrderId() == null || order.getAmountPence() <= 0) {
            // No captured provider payment behind this order (defensive — mirrors tryRefund): nothing
            // to return, so the debt is closed rather than swept forever.
            order.markRefunded(now);
            return true;
        }
        try {
            payments.refund(
                    order.getProviderOrderId(),
                    order.getAmountPence(),
                    payments.currency(),
                    String.valueOf(order.getId()));
            order.markRefunded(now);
            log.info(
                    "Refund sweep recovered order {} (provider order {}) — refund issued.",
                    order.getId(),
                    order.getProviderOrderId());
            return true;
        } catch (PaymentProviderException e) {
            boolean abandoned = order.recordFailedRefundAttempt(MAX_REFUND_ATTEMPTS, now);
            if (abandoned) {
                log.error(
                        "Refund sweep gave up on order {} (provider order {}) after {} attempts — moved to "
                                + "REFUND_ABANDONED; a permanently-rejected refund needs manual reconciliation "
                                + "(TM-726).",
                        order.getId(),
                        order.getProviderOrderId(),
                        order.getRefundAttempts(),
                        e);
            } else {
                log.warn(
                        "Refund sweep attempt {} for order {} (provider order {}) failed — stays REFUND_DUE "
                                + "for the next pass.",
                        order.getRefundAttempts(),
                        order.getId(),
                        order.getProviderOrderId(),
                        e);
            }
            return false;
        }
    }

    /**
     * Retry the refund one {@code REFUND_DUE} subscription charge owes — the subscription-ledger twin
     * of {@link #processOrder}, with the same lock/refresh/re-check discipline.
     *
     * @return {@code true} when the row was resolved, {@code false} for a no-op or a still-failing
     *         refund (retried next tick)
     */
    @Transactional
    public boolean processCharge(Long chargeId) {
        SubscriptionCharge charge = charges.findById(chargeId).orElse(null);
        if (charge == null || charge.getStatus() != SubscriptionCharge.Status.REFUND_DUE) {
            return false;
        }
        users.lockForUpdate(charge.getUserId());
        try {
            entityManager.refresh(charge);
        } catch (EntityNotFoundException gone) {
            return false;
        }
        if (charge.getStatus() != SubscriptionCharge.Status.REFUND_DUE) {
            return false;
        }
        Instant now = Instant.now();
        if (charge.getProviderOrderId() == null || charge.getAmountPence() <= 0) {
            charge.markRefunded(now); // defensive: no captured provider payment to return
            return true;
        }
        try {
            payments.refund(
                    charge.getProviderOrderId(),
                    charge.getAmountPence(),
                    payments.currency(),
                    "sub-charge:" + charge.getId());
            charge.markRefunded(now);
            log.info(
                    "Refund sweep recovered subscription charge {} (provider order {}) — refund issued.",
                    charge.getId(),
                    charge.getProviderOrderId());
            return true;
        } catch (PaymentProviderException e) {
            boolean abandoned = charge.recordFailedRefundAttempt(MAX_REFUND_ATTEMPTS, now);
            if (abandoned) {
                log.error(
                        "Refund sweep gave up on subscription charge {} (provider order {}) after {} "
                                + "attempts — moved to REFUND_ABANDONED; a permanently-rejected refund needs "
                                + "manual reconciliation (TM-726).",
                        charge.getId(),
                        charge.getProviderOrderId(),
                        charge.getRefundAttempts(),
                        e);
            } else {
                log.warn(
                        "Refund sweep attempt {} for subscription charge {} (provider order {}) failed — "
                                + "stays REFUND_DUE for the next pass.",
                        charge.getRefundAttempts(),
                        charge.getId(),
                        charge.getProviderOrderId(),
                        e);
            }
            return false;
        }
    }
}
