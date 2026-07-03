package com.teammarhaba.backend.event;

import jakarta.persistence.LockModeType;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Data access for {@link Event} (TM-391).
 *
 * <p>All queries here (and the inherited {@code findAll}/{@code findById}) honour the entity's
 * {@code @SQLRestriction}, so they return <em>active</em> rows only — soft-deleted events are
 * invisible by default.
 */
public interface EventRepository extends JpaRepository<Event, Long> {

    /**
     * The visible-now listing: events whose visibility window contains {@code now} and whose status
     * matches (the public listing passes {@link EventStatus#PUBLISHED}; cancelled events drop out
     * immediately). Soft-deleted events are excluded by the {@code @SQLRestriction}. Callers supply
     * the order via {@code pageable} — the listing sorts by {@code startAt} ascending (soonest
     * first).
     */
    @Query(
            """
            select e from Event e
            where e.status = :status
              and e.visibilityStart <= :now
              and e.visibilityEnd >= :now
            """)
    Page<Event> findVisibleAt(@Param("now") Instant now, @Param("status") EventStatus status, Pageable pageable);

    /**
     * The reminder scanner's candidate window (TM-394): events of {@code status} starting inside
     * {@code (from, to]} — strictly after {@code from} (an event starting this very instant has
     * started; nothing left to remind) and no further out than {@code to} (the scan horizon, i.e.
     * the widest milestone offset). Deliberately ignores the visibility window: reminders follow
     * <em>attendance</em>, so an event whose listing window has closed still nudges the people who
     * already joined. Soft-deleted events are excluded by the {@code @SQLRestriction}; covered by
     * {@code idx_events_start_at}.
     */
    @Query(
            """
            select e from Event e
            where e.status = :status
              and e.startAt > :from
              and e.startAt <= :to
            """)
    List<Event> findStartingBetween(
            @Param("status") EventStatus status, @Param("from") Instant from, @Param("to") Instant to);

    /**
     * Load the event holding a {@code SELECT ... FOR UPDATE} row lock — <b>the</b> locking
     * discipline for every capacity-affecting write (TM-393). RSVP, un-RSVP and claim all start by
     * taking this lock inside their transaction, so concurrent joins/claims on the same event
     * serialise: capacity checks read committed truth, oversell is impossible and first-claim-wins
     * falls out for free. Locking one {@code events} row per event keeps contention scoped — writes
     * to different events never queue behind each other. The {@code @SQLRestriction} still applies:
     * soft-deleted events don't load (or lock).
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select e from Event e where e.id = :id")
    Optional<Event> findByIdForUpdate(@Param("id") Long id);
}
