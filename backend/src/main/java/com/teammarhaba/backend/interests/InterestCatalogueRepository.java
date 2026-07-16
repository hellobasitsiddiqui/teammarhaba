package com.teammarhaba.backend.interests;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Data access for {@link InterestCatalogue} (TM-773 read path + TM-774 admin write path).
 *
 * <p><b>Two query families with opposite visibility.</b> The derived/JPQL methods here (and the
 * inherited {@code findAll}/{@code findById}) honour the entity's {@code @SQLRestriction("deleted_at
 * is null")}, so they return <em>active</em> (non-tombstoned) rows only — soft-deleted (retired)
 * interests are invisible. The user-facing picker relies on that. But the ADMIN console (TM-774)
 * must see and un-retire tombstoned rows, so it needs queries that <em>bypass</em> the restriction —
 * and the only way to escape a Hibernate {@code @SQLRestriction} (which is appended to every HQL /
 * derived query for this entity) is a <b>native</b> query. Hence the three {@code nativeQuery = true}
 * methods below; they are the crux of the admin feature (without them the console can neither list a
 * retired interest nor load one to restore it).
 *
 * <p>Note the two independent lifecycle notions the schema carries: {@code deleted_at} (the
 * {@code @SQLRestriction} tombstone that hides a row entirely) and the visible {@code active} flag
 * (a normal column callers filter on). The admin list surfaces both.
 */
public interface InterestCatalogueRepository extends JpaRepository<InterestCatalogue, Long> {

    /**
     * The ordered catalogue listing: highlights/popular first (higher {@code sortWeight} first), then
     * alphabetically by {@code label}. Backed by {@code idx_interest_catalogue_sort}. Only active
     * (non-tombstoned) interests appear (the {@code @SQLRestriction}). This is the USER-facing read.
     */
    List<InterestCatalogue> findAllByOrderBySortWeightDescLabelAsc();

    /**
     * The active (offered) catalogue rows whose label is one of the given labels, in one
     * {@code WHERE label IN (…)} read (no N+1). Honours the entity's {@code @SQLRestriction}
     * (soft-deleted/tombstoned rows are already excluded) and additionally filters {@code active = true},
     * so only <em>currently offered</em> interests match — both retirement notions are covered. Labels
     * that are unknown or retired are simply absent from the result, so the caller (TM-775) diffs the
     * requested set against this to reject an unknown/retired pick with a {@code 400}. Backed by the
     * label index.
     */
    List<InterestCatalogue> findByActiveTrueAndLabelIn(Collection<String> labels);

    /**
     * Admin listing (TM-774): the FULL catalogue including retired (tombstoned) rows — native, so the
     * entity's {@code @SQLRestriction} is bypassed. Optional filters:
     *
     * <ul>
     *   <li>{@code q} — {@code null} → no text filter; otherwise a case-insensitive substring match on
     *       {@code label}.</li>
     *   <li>{@code category} — {@code null} → all categories; otherwise an exact-category filter.</li>
     *   <li>{@code active} — {@code null} → all rows (active AND retired); {@code true}/{@code false}
     *       filter on the visible {@code active} column.</li>
     * </ul>
     *
     * <p>Ordering + paging come from {@code pageable}. Because this is a native query, the
     * {@code Pageable}'s sort properties are appended verbatim as SQL column names, so the caller must
     * pass a sort expressed in <b>snake_case column names</b> (the controller maps the public JPA
     * property names to columns before calling this). The {@code cast(:q as text)} keeps the parameter
     * typed as text on both the null and non-null paths (the same Postgres type-resolution guard as
     * {@code VenueRepository.search}, TM-707), so a null {@code q} doesn't default to {@code bytea} and
     * blow up {@code lower()}.
     */
    @Query(
            value =
                    """
                    SELECT * FROM interest_catalogue
                    WHERE (cast(:q as text) IS NULL
                           OR lower(label) LIKE lower(concat('%', cast(:q as text), '%')))
                      AND (cast(:category as text) IS NULL OR category = cast(:category as text))
                      AND (cast(:active as boolean) IS NULL OR active = cast(:active as boolean))
                    """,
            countQuery =
                    """
                    SELECT count(*) FROM interest_catalogue
                    WHERE (cast(:q as text) IS NULL
                           OR lower(label) LIKE lower(concat('%', cast(:q as text), '%')))
                      AND (cast(:category as text) IS NULL OR category = cast(:category as text))
                      AND (cast(:active as boolean) IS NULL OR active = cast(:active as boolean))
                    """,
            nativeQuery = true)
    Page<InterestCatalogue> adminSearch(
            @Param("q") String q,
            @Param("category") String category,
            @Param("active") Boolean active,
            Pageable pageable);

    /**
     * Admin find-by-id INCLUDING retired rows (TM-774) — native, bypassing the {@code @SQLRestriction}.
     * The admin edit-form load, retire and restore paths all need to resolve a tombstoned interest
     * (the restriction-honouring inherited {@code findById} returns empty for one).
     */
    @Query(value = "SELECT * FROM interest_catalogue WHERE id = :id", nativeQuery = true)
    Optional<InterestCatalogue> findByIdIncludingRetired(@Param("id") long id);

    /**
     * How many ACTIVE (non-tombstoned) rows already hold {@code label}, excluding the row with
     * {@code excludeId} (pass {@code null} to exclude nothing) — the active-label-uniqueness probe for
     * create / rename / restore (TM-774). Native so it sees the same namespace the partial-unique index
     * {@code uq_interest_catalogue_label_active} guards (only {@code deleted_at IS NULL} rows). The
     * {@code excludeId} lets a rename skip the row being edited.
     */
    @Query(
            value =
                    """
                    SELECT count(*) FROM interest_catalogue
                    WHERE deleted_at IS NULL AND label = :label
                      AND (cast(:excludeId as bigint) IS NULL OR id <> cast(:excludeId as bigint))
                    """,
            nativeQuery = true)
    long countActiveByLabelExcludingId(@Param("label") String label, @Param("excludeId") Long excludeId);
}
