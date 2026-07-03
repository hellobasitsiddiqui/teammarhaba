package com.teammarhaba.backend.event;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The recurring trigger for the event reminder scan (TM-394): a plain Spring {@code @Scheduled}
 * fixed-delay tick (enabled app-wide by {@code SchedulingConfig}) that delegates every pass to
 * {@link EventReminderService#remindDueEvents}. All the logic — due-ness, idempotent claims, the
 * push fan-out — lives in the service, so tests drive it directly and deterministically; this
 * class is only the heartbeat.
 *
 * <p><strong>Cadence.</strong> Fixed delay (not fixed rate), so a slow pass can never stack the
 * next one behind it in the same instance; the default 60s gives a worst-case ~1 minute lateness
 * on a milestone, which is noise against 24h/1h offsets. Every instance may tick — overlap across
 * instances is safe because the service's persisted per-(event, milestone) claim decides the
 * single sender.
 *
 * <p><strong>Knobs</strong> ({@code app.event-reminders.*}, see {@code application.yml}):
 * {@code enabled} (this bean simply isn't created when false — the {@code test} profile does that
 * so integration tests stay deterministic), {@code scan-interval-ms} and {@code initial-delay-ms}
 * (the startup grace so a booting instance doesn't scan mid-migration warm-up).
 *
 * <p>A pass that throws is logged and swallowed here so one bad tick can never kill the schedule.
 */
@Component
@ConditionalOnProperty(name = "app.event-reminders.enabled", havingValue = "true", matchIfMissing = true)
public class EventReminderScheduler {

    private static final Logger log = LoggerFactory.getLogger(EventReminderScheduler.class);

    private final EventReminderService reminders;

    public EventReminderScheduler(EventReminderService reminders) {
        this.reminders = reminders;
    }

    /** One heartbeat: scan and send whatever is due. Never lets an exception escape the schedule. */
    @Scheduled(
            fixedDelayString = "${app.event-reminders.scan-interval-ms:60000}",
            initialDelayString = "${app.event-reminders.initial-delay-ms:15000}")
    public void tick() {
        try {
            int sent = reminders.remindDueEvents();
            if (sent > 0) {
                log.info("Event reminder tick sent {} reminder(s).", sent);
            }
        } catch (RuntimeException e) {
            log.error("Event reminder tick failed; will retry on the next interval.", e);
        }
    }
}
