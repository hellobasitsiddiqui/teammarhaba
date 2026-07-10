package com.teammarhaba.backend.membership;

import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The recurring trigger for {@code REFUND_DUE} retries (TM-625): a plain Spring {@code @Scheduled}
 * fixed-delay tick (enabled app-wide by {@code SchedulingConfig}) that asks {@link RefundSweepService}
 * for the orders/charges still owing the customer money and feeds each through its own transaction —
 * the exact heartbeat/service split {@code SubscriptionRenewalScheduler} established, so the refund
 * logic stays deterministic under test. The loop lives HERE (outside the service) so each
 * {@code processOrder}/{@code processCharge} call goes through the Spring {@code @Transactional} proxy
 * — the same self-invocation trap the renewal scheduler documents.
 *
 * <p><strong>Cadence.</strong> Fixed delay, 1 hour by default ({@code refund-sweep-interval-ms}):
 * refunds are recovery work, not latency-sensitive — the live paths already attempt the refund inline,
 * so the sweep only ever sees rows whose first attempt failed. A row that throws is logged and skipped
 * so one poisoned refund can never stall the rest of the pass; overlap between instances is safe
 * because each row is re-checked under the owner's user-row lock.
 *
 * <p><strong>Kill switch (TM-625).</strong> Gated on the SAME opt-in pair as the renewal scheduler:
 * BOTH {@code app.subscriptions.enabled} AND {@code app.membership.enabled} must be explicitly
 * {@code true} ({@code matchIfMissing = false}) for this bean to exist. It moves money (back to the
 * customer, but still a provider mutation), so it follows the money-mover rule: no context that didn't
 * explicitly opt in ever ticks it, and a feature rollback stops it together with the charging side.
 */
@Component
@ConditionalOnProperty(
        name = {"app.subscriptions.enabled", "app.membership.enabled"},
        havingValue = "true",
        matchIfMissing = false)
public class RefundSweepScheduler {

    private static final Logger log = LoggerFactory.getLogger(RefundSweepScheduler.class);

    private final RefundSweepService refunds;

    public RefundSweepScheduler(RefundSweepService refunds) {
        this.refunds = refunds;
    }

    /** One heartbeat: retry every owed refund in both ledgers, one transaction per row. Never throws. */
    @Scheduled(
            fixedDelayString = "${app.subscriptions.refund-sweep-interval-ms:3600000}",
            initialDelayString = "${app.subscriptions.initial-delay-ms:30000}")
    public void tick() {
        try {
            int recovered = 0;
            List<Long> dueOrders = refunds.findRefundDueOrderIds();
            for (Long id : dueOrders) {
                try {
                    if (refunds.processOrder(id)) {
                        recovered++;
                    }
                } catch (RuntimeException e) {
                    // One poisoned row (optimistic-lock loser, unexpected provider blow-up…) must not
                    // stall the rest of the pass; it is retried next tick.
                    log.error("Refund sweep failed for order {}; will retry next tick.", id, e);
                }
            }
            List<Long> dueCharges = refunds.findRefundDueChargeIds();
            for (Long id : dueCharges) {
                try {
                    if (refunds.processCharge(id)) {
                        recovered++;
                    }
                } catch (RuntimeException e) {
                    log.error("Refund sweep failed for subscription charge {}; will retry next tick.", id, e);
                }
            }
            if (recovered > 0) {
                log.info("Refund sweep tick recovered {} owed refund(s).", recovered);
            }
        } catch (RuntimeException e) {
            log.error("Refund sweep tick failed; will retry on the next interval.", e);
        }
    }
}
