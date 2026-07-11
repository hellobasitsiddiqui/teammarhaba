package com.teammarhaba.backend.membership;

import com.teammarhaba.backend.config.PaymentsProperties;
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
 * The abandoned-PENDING-order TTL sweep (TM-634): finds every PAY {@link Order} still {@code PENDING} past
 * the {@code app.payments.pending-ttl} window — a checkout whose settle or decline webhook never arrived
 * (the customer closed the tab, or the provider never delivered the event) — and moves it to a terminal
 * {@code EXPIRED} state, voiding its provider order best-effort on the way out. Driven by
 * {@link PendingOrderSweepScheduler}'s fixed-delay tick; all the logic lives here so tests exercise it
 * directly and deterministically (the same heartbeat/service split as {@link RefundSweepService}).
 *
 * <p><strong>Why this exists.</strong> Before TM-634 the webhook path handled only the settle events, so a
 * PENDING order whose payment was declined, or whose webhook simply never came, sat {@code PENDING} forever:
 * no RSVP, no cleanup, and a still-live single-use widget token able to capture money nothing local would
 * reconcile. This sweep is the cleanup: it retires the stale order and voids the token.
 *
 * <p><strong>Money-safety.</strong> The TTL (default 30m) is far longer than a real widget payment takes, so
 * a genuinely in-flight payment is never expired. The provider void is best-effort — a payment that captured
 * just before the sweep makes Revolut refuse the cancel, and the order is still moved to {@code EXPIRED}; a
 * late settle webhook for it is then caught by {@link CheckoutService#confirmPayment}'s settle-after-terminal
 * race handling (flagged {@code REFUND_DUE} + refunded), exactly like a late settle after an in-window cancel.
 *
 * <p><strong>Concurrency.</strong> Each row is processed in its OWN transaction (one poisoned row can't fail
 * the pass), re-read fresh ({@code EntityManager.refresh}) under the buyer's user-row lock so a webhook
 * confirm/fail or a user cancel racing the sweep serialises instead of double-driving the same order. Any
 * number of instances may tick — the status re-check after the lock makes a second sweeper a no-op.
 */
@Service
public class PendingOrderSweepService {

    private static final Logger log = LoggerFactory.getLogger(PendingOrderSweepService.class);

    /** Upper bound on rows handled per pass (oldest first; the next tick takes the rest). */
    private static final int SCAN_LIMIT = 100;

    private final OrderRepository orders;
    private final UserService users;
    private final PaymentProvider payments;
    private final EntityManager entityManager;
    private final PaymentsProperties props;

    public PendingOrderSweepService(
            OrderRepository orders,
            UserService users,
            PaymentProvider payments,
            EntityManager entityManager,
            PaymentsProperties props) {
        this.orders = orders;
        this.users = users;
        this.payments = payments;
        this.entityManager = entityManager;
        this.props = props;
    }

    /**
     * The PAY orders that have sat {@code PENDING} past the TTL as of {@code now} (oldest first, bounded).
     * Ids only — each is then re-checked under its own lock in {@link #expireOrder}.
     */
    @Transactional(readOnly = true)
    public List<Long> findExpiredPendingOrderIds(Instant now) {
        Instant cutoff = now.minus(props.pendingTtl());
        return orders
                .findByStatusAndCreatedAtBeforeOrderByIdAsc(OrderStatus.PENDING, cutoff, PageRequest.of(0, SCAN_LIMIT))
                .stream()
                .map(Order::getId)
                .toList();
    }

    /**
     * Expire one abandoned PENDING order, in its own transaction under the buyer's user-row lock: void the
     * provider order best-effort, then move it {@code PENDING → EXPIRED}. Re-checks the status under the lock
     * so an order that settled/cancelled/failed between the scan and here is left untouched.
     *
     * @return {@code true} when this call actually expired the order, {@code false} for a no-longer-PENDING
     *         no-op (settled/cancelled/gone while we waited)
     */
    @Transactional
    public boolean expireOrder(Long orderId, Instant now) {
        Order order = orders.findById(orderId).orElse(null);
        if (order == null || order.getStatus() != OrderStatus.PENDING) {
            return false; // resolved between the scan and here — nothing to do
        }
        // Serialise with webhook confirm/fail and user cancel on this buyer (best-effort: no-ops for a
        // soft-deleted user — the refresh + status re-check below still make the sweep race-safe).
        users.lockForUpdate(order.getUserId());
        try {
            entityManager.refresh(order); // committed state, not the stale L1-cache snapshot (TM-623)
        } catch (EntityNotFoundException gone) {
            return false; // row deleted while we waited for the lock
        }
        if (order.getStatus() != OrderStatus.PENDING) {
            return false; // whoever held the lock before us already resolved it (settled/cancelled/failed)
        }

        // Void the still-live provider order best-effort so its single-use widget token can no longer
        // capture money that nothing local would reconcile. A refusal (the payment is completing / already
        // completed) is logged and swallowed — the order is still expired locally, and any late settle is
        // caught by CheckoutService.confirmPayment's settle-after-terminal race handling.
        if (order.getProviderOrderId() != null) {
            try {
                payments.cancelOrder(order.getProviderOrderId());
            } catch (PaymentProviderException e) {
                log.warn(
                        "Could not void provider order {} while expiring abandoned order {} — reconcile it "
                                + "manually if it is ever paid.",
                        order.getProviderOrderId(),
                        order.getId(),
                        e);
            }
        }

        order.expirePending(now);
        log.info("Expired abandoned PENDING order {} past its TTL (TM-634).", order.getId());
        return true;
    }
}
