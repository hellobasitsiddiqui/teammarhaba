package com.teammarhaba.backend.event;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Pageable;
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

    /** The caller's rows across many events in one query — the listing's "my-state" without an N+1. */
    List<EventAttendance> findByUserIdAndEventIdIn(Long userId, Collection<Long> eventIds);

    /**
     * A slice of one event's attendance in a given state — the detail view passes {@code GOING}
     * with a page of the first N by ({@code createdAt}, {@code id}) to build the attendee-avatar
     * strip in join order.
     */
    List<EventAttendance> findByEventIdAndState(Long eventId, AttendanceState state, Pageable pageable);

    /**
     * All attendance rows of one state on one event — the reminder fan-out's recipient source
     * ({@code GOING} only, TM-394). Rows, not people: callers must resolve each {@code userId}
     * through {@code UserRepository} (see the class note). Covered by
     * {@code idx_event_attendance_event_state}.
     */
    List<EventAttendance> findByEventIdAndState(Long eventId, AttendanceState state);

    /**
     * The distinct user ids {@code GOING} to <em>any</em> of {@code eventIds} — the attendee audience
     * for admin messaging (TM-440), unioned across one or many events in a single query. A snapshot of
     * current {@code GOING} membership at call time.
     *
     * <p>Rows, not people: as everywhere in this repository, an id here may belong to a soft-deleted
     * account (attendance rows deliberately outlive an attendee's account tombstone — see the class
     * note), so the caller MUST resolve these ids through {@code UserRepository}
     * ({@code findActiveIdsByIdIn}) before delivering, which is exactly what {@code RecipientResolver}
     * does. Covered by {@code idx_event_attendance_event_state}. Pass a non-empty collection.
     */
    @Query(
            """
            select distinct a.userId from EventAttendance a
            where a.eventId in :eventIds
              and a.state = com.teammarhaba.backend.event.AttendanceState.GOING
            """)
    List<Long> findGoingUserIds(@Param("eventIds") Collection<Long> eventIds);

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

    /**
     * The cascade-stop wipe (TM-393): void every live offer left on the event's waitlist. The
     * claim service calls this when a claim fills the <em>last</em> free spot — remaining
     * waitlisted members no longer have a spot available, and the next freed spot starts a fresh
     * cascade from a clean slate. Runs under the event's {@code FOR UPDATE} lock (the claim
     * transaction), so it can never race another claim's bookkeeping. Returns the number of
     * offers voided.
     */
    @Modifying
    @Query(
            """
            update EventAttendance a set a.offerNotifiedAt = null
            where a.eventId = :eventId
              and a.state = com.teammarhaba.backend.event.AttendanceState.WAITLISTED
              and a.offerNotifiedAt is not null
            """)
    int clearOpenOffers(@Param("eventId") Long eventId);

    /** Projection for {@link #tallyByEventIds}: one row per (event, state) with its count. */
    interface AttendanceTally {

        Long getEventId();

        AttendanceState getState();

        long getTotal();
    }
}
