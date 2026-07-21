package com.teammarhaba.backend.interests;

import java.util.Collection;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

/**
 * Data access for {@link UserInterest} (TM-773) — the per-user free-text snapshot log.
 *
 * <p>People are resolved through {@code UserRepository} (which hides soft-deleted accounts), never by
 * joining through this table; a {@code userId} here may belong to a tombstoned account (the snapshot
 * outlives the account tombstone, since the FK only cascades on a hard account delete).
 */
public interface UserInterestRepository extends JpaRepository<UserInterest, Long> {

    /** One user's saved interests (owner-scoped; mirrors {@code DeviceTokenRepository.findByUserId}). */
    List<UserInterest> findByUserId(Long userId);

    /**
     * The saved interests of any of the given {@code userIds} in one {@code WHERE user_id IN (…)} read
     * — the batched counterpart of {@link #findByUserId(Long)} (parity with device tokens), for future
     * fan-out reads (I4+) without an N+1. Ids with no saved interest are simply absent from the result.
     */
    List<UserInterest> findByUserIdIn(Collection<Long> userIds);

    /**
     * How many saved snapshots point at the given source catalogue id. Used to prove the snapshot
     * survives its source catalogue interest being retired or hard-deleted (the invariant test): the
     * count stays put because {@code source_interest_id} is a soft pointer, not a cascading FK.
     */
    long countBySourceInterestId(Long sourceInterestId);

    /**
     * Per-LABEL selection tallies across the WHOLE snapshot log (TM-832) — {@code COUNT(*) GROUP BY
     * label} — the aggregate behind the admin interests console's "Selected by" analytics. ONE query
     * (never an N+1): every label's selector count comes back in a single grouped scan, and the caller
     * joins it to the catalogue rows by label.
     *
     * <p>Keyed on the snapshot's FREE-TEXT {@code label} (TM-773), deliberately NOT on
     * {@code source_interest_id}: a selection of a since-renamed or since-retired interest is still
     * counted under the label it was picked as, which is exactly the label the catalogue row is matched
     * by. That means a retired catalogue interest still shows its historical selection count, and it is
     * why the count "correctly includes selections of a since-retired interest" (the ticket contract).
     *
     * <p>Returned as a lightweight {@link LabelCount} projection (label + count) rather than entities;
     * a label with zero selections is simply absent (the caller treats a missing label as 0).
     */
    @Query("select ui.label as label, count(ui) as count from UserInterest ui group by ui.label")
    List<LabelCount> selectionCountsByLabel();

    /** A single {@code (label, count)} tally row from {@link #selectionCountsByLabel()} (TM-832). */
    interface LabelCount {
        String getLabel();

        long getCount();
    }
}
