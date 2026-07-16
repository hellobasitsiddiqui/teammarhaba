package com.teammarhaba.backend.interests;

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
}
