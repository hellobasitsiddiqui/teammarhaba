package com.teammarhaba.backend.event;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The recurring trigger for the waitlist offer cascade (TM-397): a plain Spring {@code @Scheduled}
 * fixed-delay tick (enabled app-wide by {@code SchedulingConfig}) that delegates every pass to
 * {@link WaitlistOfferCascadeService#sweepOpenOffers}. Exactly the shape of the reminder scheduler
 * (TM-394): all the logic — free-spot derivation, the FIFO widening, the 5-minute spacing, the
 * per-event lock and idempotent stamps — lives in the service, so tests drive it directly with a
 * controlled clock; this class is only the heartbeat.
 *
 * <p><strong>Cadence.</strong> Fixed delay (not fixed rate), so a slow pass can never stack the next
 * one behind it; the default ~60s tick gives at most ~1 minute of lateness on a 5-minute widening
 * boundary — well within tolerance. Every instance may tick — overlap across instances is safe
 * because the service stamps under the event's {@code FOR UPDATE} lock and the persisted {@code
 * offer_notified_at} marker is the cross-instance idempotency guard.
 *
 * <p><strong>Knobs</strong> ({@code app.offer-cascade.*}, see {@code application.yml}):
 * {@code enabled} (this bean simply isn't created when false — the {@code test} profile does that so
 * integration tests stay deterministic and drive the service themselves), {@code scan-interval-ms}
 * and {@code initial-delay-ms} (the startup grace before the first sweep).
 *
 * <p>A pass that throws is logged and swallowed here so one bad tick can never kill the schedule.
 */
@Component
@ConditionalOnProperty(name = "app.offer-cascade.enabled", havingValue = "true", matchIfMissing = true)
public class WaitlistOfferCascadeScheduler {

    private static final Logger log = LoggerFactory.getLogger(WaitlistOfferCascadeScheduler.class);

    private final WaitlistOfferCascadeService cascade;

    public WaitlistOfferCascadeScheduler(WaitlistOfferCascadeService cascade) {
        this.cascade = cascade;
    }

    /** One heartbeat: sweep open free-spots and widen the offers that are due. Never lets one escape. */
    @Scheduled(
            fixedDelayString = "${app.offer-cascade.scan-interval-ms:60000}",
            initialDelayString = "${app.offer-cascade.initial-delay-ms:20000}")
    public void tick() {
        try {
            int offered = cascade.sweepOpenOffers();
            if (offered > 0) {
                log.info("Offer cascade tick widened {} offer(s).", offered);
            }
        } catch (RuntimeException e) {
            log.error("Offer cascade tick failed; will retry on the next interval.", e);
        }
    }
}
