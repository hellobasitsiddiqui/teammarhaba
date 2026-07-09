package com.teammarhaba.backend.event;

import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The recurring trigger for the event-chat close sweep (TM-578): a plain Spring {@code @Scheduled}
 * fixed-delay tick (enabled app-wide by {@code SchedulingConfig}) that delegates every pass to
 * {@link EventChatLifecycleService#sweepDueThreadCloses}. Exactly the shape of the reminder
 * (TM-394) and offer-cascade (TM-397) schedulers: all the logic — the candidate query, the
 * idempotent first-moment-wins close, the batch cap — lives in the service, so tests drive it
 * directly with a controlled {@code now}; this class is only the heartbeat.
 *
 * <p>Its job is to give {@link EventChatLifecycleService#closeThreadIfDue} the caller it never had.
 * Before this, a thread past its policy close window was only ever read-only <em>live</em> (via
 * {@code isThreadReadOnly}); its persisted {@code conversation.closed_at} was never stamped, so paths
 * that key on the stored flag (reactions, TM-574) saw an open thread. The sweep reconciles that flag.
 *
 * <p><strong>Cadence.</strong> Fixed delay (not fixed rate), so a slow pass can never stack the next
 * one behind it; the default is <b>hourly</b> — deliberately coarse. The close window is itself
 * measured in whole <em>hours</em> after an event ends, and read-only enforcement is already exact
 * and live (a post/reaction 409s the instant the window passes, whatever the stamp says), so this
 * sweep only trues-up the stored flag; up to ~an hour of lateness on that reconciliation is
 * immaterial and keeps the scan load negligible. Every instance may tick — overlap is safe because
 * the close is idempotent (set-if-null to the same policy instant).
 *
 * <p><strong>Knobs</strong> ({@code app.event-chat-close.*}, see {@code application.yml}):
 * {@code enabled} (this bean simply isn't created when false — the {@code test} profile does that so
 * integration tests drive the service themselves), {@code scan-interval-ms}, {@code initial-delay-ms}
 * (startup grace before the first sweep) and {@code batch-size} (the per-pass cap).
 *
 * <p>A pass that throws is logged and swallowed here so one bad tick can never kill the schedule.
 */
@Component
@ConditionalOnProperty(name = "app.event-chat-close.enabled", havingValue = "true", matchIfMissing = true)
public class EventChatCloseScheduler {

    private static final Logger log = LoggerFactory.getLogger(EventChatCloseScheduler.class);

    private final EventChatLifecycleService lifecycle;
    private final int batchSize;

    public EventChatCloseScheduler(
            EventChatLifecycleService lifecycle,
            @Value("${app.event-chat-close.batch-size:200}") int batchSize) {
        this.lifecycle = lifecycle;
        this.batchSize = batchSize;
    }

    /** One heartbeat: soft-close whatever event threads are due. Never lets an exception escape the schedule. */
    @Scheduled(
            fixedDelayString = "${app.event-chat-close.scan-interval-ms:3600000}",
            initialDelayString = "${app.event-chat-close.initial-delay-ms:30000}")
    public void tick() {
        try {
            int closed = lifecycle.sweepDueThreadCloses(Instant.now(), batchSize);
            if (closed > 0) {
                log.info("Event chat close tick soft-closed {} thread(s).", closed);
            }
        } catch (RuntimeException e) {
            log.error("Event chat close tick failed; will retry on the next interval.", e);
        }
    }
}
