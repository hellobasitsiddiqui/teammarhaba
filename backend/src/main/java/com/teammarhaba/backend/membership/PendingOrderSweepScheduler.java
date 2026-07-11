package com.teammarhaba.backend.membership;

import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The recurring trigger for the abandoned-PENDING-order TTL sweep (TM-634): a plain Spring
 * {@code @Scheduled} fixed-delay tick (enabled app-wide by {@code SchedulingConfig}) that asks
 * {@link PendingOrderSweepService} for the PAY orders that have sat {@code PENDING} past the
 * {@code app.payments.pending-ttl} window and feeds each through its own transaction — the exact
 * heartbeat/service split {@link RefundSweepScheduler} established, so the expiry logic stays deterministic
 * under test. The loop lives HERE (outside the service) so each {@code expireOrder} call goes through the
 * Spring {@code @Transactional} proxy — the same self-invocation trap the refund/renewal schedulers document.
 *
 * <p><strong>Cadence.</strong> Fixed delay, 5 minutes by default ({@code pending-sweep-interval-ms}): a
 * stale PENDING order is not latency-sensitive (its whole point is that nothing is happening to it), and the
 * TTL itself is the real timer — this only decides how promptly an already-expired order is retired. A row
 * that throws is logged and skipped so one poisoned order can never stall the rest of the pass; overlap
 * between instances is safe because each row is re-checked under the buyer's user-row lock.
 *
 * <p><strong>Kill switch.</strong> Gated on {@code app.membership.enabled} ALONE (explicitly {@code true},
 * {@code matchIfMissing = false}) — exactly like {@link RefundSweepScheduler}. The PENDING orders it retires
 * are produced only by the membership-gated PAY checkout branch ({@code CheckoutService.checkout}), so the
 * gate must match that producer: no producer, no sweeper. It also moves money (a best-effort provider void),
 * so it keeps the money-mover rule — no context that didn't explicitly opt in to membership ever ticks it.
 */
@Component
@ConditionalOnProperty(name = "app.membership.enabled", havingValue = "true", matchIfMissing = false)
public class PendingOrderSweepScheduler {

    private static final Logger log = LoggerFactory.getLogger(PendingOrderSweepScheduler.class);

    private final PendingOrderSweepService sweep;

    public PendingOrderSweepScheduler(PendingOrderSweepService sweep) {
        this.sweep = sweep;
    }

    /** One heartbeat: expire every PENDING order past its TTL, one transaction per row. Never throws. */
    @Scheduled(
            fixedDelayString = "${app.payments.pending-sweep-interval-ms:300000}",
            initialDelayString = "${app.payments.pending-sweep-initial-delay-ms:30000}")
    public void tick() {
        try {
            Instant now = Instant.now();
            int expired = 0;
            List<Long> stale = sweep.findExpiredPendingOrderIds(now);
            for (Long id : stale) {
                try {
                    if (sweep.expireOrder(id, now)) {
                        expired++;
                    }
                } catch (RuntimeException e) {
                    // One poisoned row (optimistic-lock loser, unexpected provider blow-up…) must not
                    // stall the rest of the pass; it is retried next tick.
                    log.error("Pending-order sweep failed for order {}; will retry next tick.", id, e);
                }
            }
            if (expired > 0) {
                log.info("Pending-order sweep tick expired {} abandoned order(s).", expired);
            }
        } catch (RuntimeException e) {
            log.error("Pending-order sweep tick failed; will retry on the next interval.", e);
        }
    }
}
