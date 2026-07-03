package com.teammarhaba.backend.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Turns on Spring's {@code @Scheduled} processing app-wide (TM-394) — the house scheduling
 * pattern's single switch. Individual jobs stay in their own {@code @Component}s next to the
 * domain they serve (first: {@code EventReminderScheduler} in {@code event}) and carry their own
 * enable/cadence knobs, so adding a job never means touching this class and a disabled job is
 * simply never instantiated.
 *
 * <p>Scheduling itself is unconditional (an empty scheduler is free); per-job conditions are the
 * off-switches. Note for future jobs: every Cloud Run instance runs its own schedule, so any job
 * with side effects must bring its own cross-instance idempotency (the reminder job's persisted
 * unique claim is the reference example).
 */
@Configuration
@EnableScheduling
public class SchedulingConfig {
}
