package com.teammarhaba.backend.city;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Data access for {@link CityCatalogue} (TM-1089 read path + admin write path).
 *
 * <p><b>Two query families with opposite visibility.</b> The derived methods here (and the inherited
 * {@code findAll}/{@code findById}) honour the entity's {@code @SQLRestriction("deleted_at is null")},
 * so they return <em>active</em> (non-tombstoned) rows only — soft-deleted (retired) cities are
 * invisible, which the user-facing picker relies on. But the ADMIN console must SEE and un-retire
 * tombstoned rows, so it needs queries that BYPASS the restriction — and the only way to escape a
 * Hibernate {@code @SQLRestriction} is a <b>native</b> query. Hence the three {@code nativeQuery = true}
 * methods below. Mirrors {@code InterestCatalogueRepository}.
 */
public interface CityCatalogueRepository extends JpaRepository<CityCatalogue, Long> {

    /**
     * The USER-facing picker read: the CURRENTLY OFFERED cities (active + not tombstoned), ordered by
     * weight (higher {@code sortWeight} first) then alphabetically by {@code name}. Filters
     * {@code active = true} in addition to the entity's {@code @SQLRestriction}, so BOTH retirement
     * notions are honoured. Backed by {@code idx_city_catalogue_sort}.
     */
    List<CityCatalogue> findByActiveTrueOrderBySortWeightDescNameAsc();

    /**
     * The active (offered) rows whose name is one of the given names, in one {@code WHERE name IN (…)}
     * read (no N+1). Honours the {@code @SQLRestriction} and additionally filters {@code active = true},
     * so only currently-offered cities match — the exact set the profile city validation will accept.
     */
    List<CityCatalogue> findByActiveTrueAndNameIn(Collection<String> names);

    /**
     * Admin listing (TM-1089): the FULL catalogue including retired (tombstoned) rows — native, so the
     * entity's {@code @SQLRestriction} is bypassed. Optional filters: {@code q} (case-insensitive
     * substring match on {@code name} OR {@code country}), and {@code active} (tri-state: {@code null} =
     * all incl. retired). Ordering + paging come from {@code pageable}; because this is native, the sort
     * must be expressed in snake_case column names (the controller maps public property names first). The
     * {@code cast(:q as text)} keeps the parameter typed as text on both paths (the same Postgres
     * type-resolution guard as the interests/venues search), so a null {@code q} doesn't blow up.
     */
    @Query(
            value =
                    """
                    SELECT * FROM city_catalogue
                    WHERE (cast(:q as text) IS NULL
                           OR lower(name) LIKE lower(concat('%', cast(:q as text), '%'))
                           OR lower(country) LIKE lower(concat('%', cast(:q as text), '%')))
                      AND (cast(:active as boolean) IS NULL OR active = cast(:active as boolean))
                    """,
            countQuery =
                    """
                    SELECT count(*) FROM city_catalogue
                    WHERE (cast(:q as text) IS NULL
                           OR lower(name) LIKE lower(concat('%', cast(:q as text), '%'))
                           OR lower(country) LIKE lower(concat('%', cast(:q as text), '%')))
                      AND (cast(:active as boolean) IS NULL OR active = cast(:active as boolean))
                    """,
            nativeQuery = true)
    Page<CityCatalogue> adminSearch(@Param("q") String q, @Param("active") Boolean active, Pageable pageable);

    /**
     * Admin find-by-id INCLUDING retired rows (TM-1089) — native, bypassing the {@code @SQLRestriction}.
     * The admin edit-form load, retire and restore paths all need to resolve a tombstoned city.
     */
    @Query(value = "SELECT * FROM city_catalogue WHERE id = :id", nativeQuery = true)
    Optional<CityCatalogue> findByIdIncludingRetired(@Param("id") long id);

    /**
     * How many ACTIVE (non-tombstoned) rows already hold {@code name}, excluding the row with
     * {@code excludeId} (pass {@code null} to exclude nothing) — the active-name-uniqueness probe for
     * create / rename / restore. Native so it sees the same namespace the partial-unique index
     * {@code uq_city_catalogue_name_active} guards.
     */
    @Query(
            value =
                    """
                    SELECT count(*) FROM city_catalogue
                    WHERE deleted_at IS NULL AND name = :name
                      AND (cast(:excludeId as bigint) IS NULL OR id <> cast(:excludeId as bigint))
                    """,
            nativeQuery = true)
    long countActiveByNameExcludingId(@Param("name") String name, @Param("excludeId") Long excludeId);
}
