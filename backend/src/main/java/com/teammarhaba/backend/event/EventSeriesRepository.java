package com.teammarhaba.backend.event;

import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Data access for {@link EventSeries} (TM-789, recurring events v1).
 *
 * <p>All queries here (and the inherited {@code findAll}/{@code findById}) honour the entity's
 * {@code @SQLRestriction("deleted_at is null")}, so they return <em>active</em> (non-tombstoned)
 * series only — soft-deleted series are invisible by default, exactly like {@link Event} /
 * {@link Venue}.
 *
 * <p><b>The one deliberate exception: {@link #findByIdIncludingDeleted}.</b> It bypasses the
 * {@code @SQLRestriction} to load a soft-deleted series by id. This is admin-only and the SOLE place
 * a tombstoned series is readable — it exists so 3b's <em>clone</em> can duplicate a series that has
 * since been deleted (you can still spin up a fresh series from a retired template). Never expose it
 * on a public path.
 */
public interface EventSeriesRepository extends JpaRepository<EventSeries, Long> {

    /**
     * Load a series by id <b>including soft-deleted rows</b> — the single, admin-only exception to the
     * entity's {@code @SQLRestriction} (TM-789). A native query is required: the {@code @SQLRestriction}
     * is woven into every JPQL/HQL statement (including the inherited {@code findById}), so only raw SQL
     * against the table sidesteps the {@code deleted_at is null} filter. Selecting {@code *} maps back to
     * the managed {@link EventSeries} entity. Reused by clone in 3b.
     */
    @Query(value = "select * from event_series where id = :id", nativeQuery = true)
    Optional<EventSeries> findByIdIncludingDeleted(@Param("id") Long id);
}
