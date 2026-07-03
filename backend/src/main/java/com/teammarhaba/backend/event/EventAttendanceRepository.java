package com.teammarhaba.backend.event;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Data access for {@link EventAttendance} (TM-391). The {@code (eventId, userId)} pair is the
 * natural key (DB-unique): {@link #findByEventIdAndUserId} backs "am I going?",
 * {@link #countByEventIdAndState} backs the capacity check and the "N going" badge, and
 * {@link #findWaitlistFifo} is the promotion queue — strict FIFO by DB-authoritative
 * {@code createdAt} (id breaks the theoretical same-instant tie deterministically).
 *
 * <p>Attendee <em>people</em> are resolved through {@code UserRepository} (which hides soft-deleted
 * accounts), never by joining through this table.
 */
public interface EventAttendanceRepository extends JpaRepository<EventAttendance, Long> {

    Optional<EventAttendance> findByEventIdAndUserId(Long eventId, Long userId);

    /** Capacity check ({@code GOING} vs {@code events.capacity}) and per-state badge counts. */
    long countByEventIdAndState(Long eventId, AttendanceState state);

    /**
     * Per-state tallies for many events in one query — the listing API's "N going" badges without
     * an N+1. States with no rows simply don't appear.
     */
    @Query(
            """
            select a.eventId as eventId, a.state as state, count(a) as total
            from EventAttendance a
            where a.eventId in :eventIds
            group by a.eventId, a.state
            """)
    List<AttendanceTally> tallyByEventIds(@Param("eventIds") Collection<Long> eventIds);

    /**
     * The event's waitlist in strict promotion order: FIFO by DB-authoritative {@code createdAt},
     * with {@code id} as the deterministic tiebreak for same-instant inserts. The first element is
     * the next attendee to {@linkplain EventAttendance#promote promote} when a slot frees up.
     */
    @Query(
            """
            select a from EventAttendance a
            where a.eventId = :eventId and a.state = com.teammarhaba.backend.event.AttendanceState.WAITLISTED
            order by a.createdAt asc, a.id asc
            """)
    List<EventAttendance> findWaitlistFifo(@Param("eventId") Long eventId);

    /**
     * Leave an event: remove the caller's own row (owner-scoped, same shape as
     * {@code DeviceTokenRepository.deleteByTokenAndUserId}). Returns 1 when a row was removed, 0
     * when the user wasn't on the event — so leave is idempotent and can never touch another
     * user's attendance. Requires an active transaction (the leave API's service is
     * {@code @Transactional}).
     */
    @Modifying
    @Query("delete from EventAttendance a where a.eventId = :eventId and a.userId = :userId")
    int deleteByEventIdAndUserId(@Param("eventId") Long eventId, @Param("userId") Long userId);

    /** Projection for {@link #tallyByEventIds}: one row per (event, state) with its count. */
    interface AttendanceTally {

        Long getEventId();

        AttendanceState getState();

        long getTotal();
    }
}
