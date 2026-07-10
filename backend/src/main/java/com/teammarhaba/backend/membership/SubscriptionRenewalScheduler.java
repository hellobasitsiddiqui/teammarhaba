package com.teammarhaba.backend.membership;

import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The recurring trigger for subscription renewals + dunning (TM-620): a plain Spring {@code @Scheduled}
 * fixed-delay tick (enabled app-wide by {@code SchedulingConfig}) that asks
 * {@link SubscriptionRenewalService} for the due subscriptions and feeds each through
 * {@link SubscriptionRenewalService#processOne} — the exact heartbeat/service split
 * {@code EventReminderScheduler} established, so all the billing logic stays deterministic under test.
 *
 * <p><strong>Why the loop lives here.</strong> Each subscription is processed in its OWN transaction
 * ({@code processOne} is {@code @Transactional}); calling it from a method <em>inside</em> the service
 * would bypass the Spring proxy and silently run everything in one transaction (the classic
 * self-invocation trap the {@code MembershipProvisioner} pattern documents). The scheduler making each
 * call from outside keeps the proxy — and the per-row isolation — real. A row that throws is logged and
 * skipped so one bad subscription can never stall everyone else's renewal.
 *
 * <p><strong>Cadence.</strong> Fixed delay, 5 minutes by default: renewals are date-based (a charge due
 * "today" being minutes late is invisible), and every instance may tick — overlap is safe because
 * {@code processOne} re-checks due-ness under the account's user-row lock and the {@code @Version}
 * column rejects a concurrent writer.
 *
 * <p><strong>Knobs</strong> ({@code app.subscriptions.*}, see {@code application.yml}): {@code enabled}
 * (this bean simply isn't created when false — the {@code test} profile does that so integration tests
 * stay deterministic), {@code scan-interval-ms} and {@code initial-delay-ms} (startup grace). The
 * dunning policy knobs live in {@code SubscriptionProperties} and are applied by the service.
 */
@Component
@ConditionalOnProperty(name = "app.subscriptions.enabled", havingValue = "true", matchIfMissing = true)
public class SubscriptionRenewalScheduler {

    private static final Logger log = LoggerFactory.getLogger(SubscriptionRenewalScheduler.class);

    private final SubscriptionRenewalService renewals;

    public SubscriptionRenewalScheduler(SubscriptionRenewalService renewals) {
        this.renewals = renewals;
    }

    /** One heartbeat: process everything due, one transaction per subscription. Never throws. */
    @Scheduled(
            fixedDelayString = "${app.subscriptions.scan-interval-ms:300000}",
            initialDelayString = "${app.subscriptions.initial-delay-ms:30000}")
    public void tick() {
        try {
            List<Long> due = renewals.findDueSubscriptionIds();
            int processed = 0;
            for (Long id : due) {
                try {
                    if (renewals.processOne(id)) {
                        processed++;
                    }
                } catch (RuntimeException e) {
                    // One poisoned row (optimistic-lock loser, provider blow-up outside the caught
                    // paths…) must not stall the rest of the pass; it is retried next tick.
                    log.error("Subscription renewal failed for subscription {}; will retry next tick.", id, e);
                }
            }
            if (processed > 0) {
                log.info("Subscription renewal tick processed {} subscription(s).", processed);
            }
        } catch (RuntimeException e) {
            log.error("Subscription renewal tick failed; will retry on the next interval.", e);
        }
    }
}
