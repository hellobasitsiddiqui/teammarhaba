package com.teammarhaba.backend.event;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Data access for {@link Venue} (TM-519).
 *
 * <p>All queries here (and the inherited {@code findAll}/{@code findById}) honour the entity's
 * {@code @SQLRestriction}, so they return <em>active</em> (non-tombstoned) rows only — soft-deleted
 * venues are invisible by default. Note the two independent lifecycle notions: the
 * {@code @SQLRestriction} hides {@code deleted_at}-stamped rows entirely, whereas the {@code active}
 * flag (the deactivate switch) is a normal, visible column the console filters on.
 */
public interface VenueRepository extends JpaRepository<Venue, Long> {

    /**
     * The admin venues listing (TM-519): the full inventory, filtered by an optional case-insensitive
     * search over {@code name}/{@code city} and an optional active-only flag.
     *
     * <ul>
     *   <li>{@code q} {@code null}/blank → no text filter (the whole inventory). Otherwise a substring
     *       match against either the name or the city, both lower-cased.</li>
     *   <li>{@code activeOnly = true} → only venues offered in the picker ({@code active = true}); the
     *       event-create picker passes this. {@code false} → include deactivated venues too (the console
     *       manages the full inventory).</li>
     * </ul>
     *
     * Soft-deleted venues are excluded by the {@code @SQLRestriction}; ordering + paging come from the
     * caller's {@link Pageable}.
     *
     * <p>{@code cast(:q as string)} is load-bearing (TM-707): Postgres type-resolves the whole
     * predicate at plan time, so a null {@code q} bound as an untyped parameter inside
     * {@code concat()}/{@code lower()} defaults to {@code bytea} and the query dies with
     * {@code function lower(bytea) does not exist} — the {@code :q is null} guard doesn't help. The
     * cast keeps the parameter typed as text on both the null and non-null paths.
     */
    @Query(
            """
            select v from Venue v
            where (
                :q is null
                or lower(v.name) like lower(concat('%', cast(:q as string), '%'))
                or (v.city is not null and lower(v.city) like lower(concat('%', cast(:q as string), '%')))
              )
              and (:activeOnly = false or v.active = true)
            """)
    Page<Venue> search(@Param("q") String q, @Param("activeOnly") boolean activeOnly, Pageable pageable);
}
