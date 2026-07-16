package com.teammarhaba.backend.interests;

import java.util.Collection;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

/**
 * Data access for {@link InterestCatalogue} (TM-773).
 *
 * <p>All queries here (and the inherited {@code findAll}/{@code findById}) honour the entity's
 * {@code @SQLRestriction}, so they return <em>active</em> (non-tombstoned) rows only — soft-deleted
 * (retired) interests are invisible by default. Note the two independent lifecycle notions: the
 * {@code @SQLRestriction} hides {@code deleted_at}-stamped rows entirely, whereas the {@code active}
 * flag is a normal, visible column callers filter on.
 */
public interface InterestCatalogueRepository extends JpaRepository<InterestCatalogue, Long> {

    /**
     * The ordered catalogue listing: highlights/popular first (higher {@code sortWeight} first), then
     * alphabetically by {@code label}. Backed by {@code idx_interest_catalogue_sort}. Only active
     * (non-tombstoned) interests appear (the {@code @SQLRestriction}).
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
}
