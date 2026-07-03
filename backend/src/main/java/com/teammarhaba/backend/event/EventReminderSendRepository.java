package com.teammarhaba.backend.event;

import java.util.Collection;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

/**
 * Data access for {@link EventReminderSend} (TM-394).
 *
 * <p>The write path that matters is inherited {@code saveAndFlush}: the reminder scheduler inserts
 * a claim row through it and relies on the DB-unique {@code (event_id, milestone)} pair to reject
 * a concurrent duplicate (translated to {@code DataIntegrityViolationException}) — that insert
 * race <em>is</em> the multi-instance idempotency mechanism, so there is deliberately no
 * check-then-insert helper here that could paper over it.
 */
public interface EventReminderSendRepository extends JpaRepository<EventReminderSend, Long> {

    /**
     * All existing claims for a batch of events in one query — the scanner's cheap pre-filter, so
     * a tick over N candidate events costs one marker read, not N×milestones {@code exists} probes.
     * (Purely an optimisation: the insert race above remains the actual guard.)
     */
    List<EventReminderSend> findByEventIdIn(Collection<Long> eventIds);
}
