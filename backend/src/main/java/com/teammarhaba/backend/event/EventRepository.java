package com.teammarhaba.backend.event;

import java.time.Instant;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
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
}
