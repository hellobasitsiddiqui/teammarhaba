package com.teammarhaba.backend.event;

import java.util.List;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.Repository;

/**
 * The waitlist offer cascade's scan (TM-397): the coarse "which events might have a spot to offer"
 * query that {@link WaitlistOfferCascadeService} sweeps each tick.
 *
 * <p>Deliberately a second, read-only {@link Repository} over {@link EventAttendance} rather than a
 * method on {@link EventAttendanceRepository}: it keeps the cascade's only bespoke query self-
 * contained in the notifications lane (TM-397) while the events model/API evolves in parallel
 * (TM-408), and it exposes exactly one method — no accidental CRUD surface. Spring Data builds an
 * independent proxy per interface, so two repositories over one entity coexist cleanly.
 *
 * <p><b>Coarse by design</b> (same shape as the reminder scanner, TM-394): it returns every event
 * that currently has <em>any</em> waitlisted row — the widest possible candidate set — and the
 * service applies the fine filter per event under the {@code SELECT … FOR UPDATE} lock (published +
 * visible + not started, and free spots derived as {@code capacity − GOING count}). The waitlist
 * only forms on at-capacity events, so this set stays small; the lock, not this read, is the guard.
 */
public interface OfferCascadeScanRepository extends Repository<EventAttendance, Long> {

    /**
     * Distinct {@code event_id}s that currently have at least one {@code WAITLISTED} attendee — the
     * cascade's candidate events. An event with no waitlist can never have an offer to make, so it
     * never appears. Served by {@code idx_event_attendance_event_state (event_id, state, …)} from
     * V11.
     */
    @Query(
            """
            select distinct a.eventId from EventAttendance a
            where a.state = com.teammarhaba.backend.event.AttendanceState.WAITLISTED
            """)
    List<Long> findEventIdsWithWaitlist();
}
