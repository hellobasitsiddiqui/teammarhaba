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
     * Per-LABEL selection tallies over the snapshots owned by ACTIVE users (TM-832, TM-961) — a
     * {@code COUNT(*) GROUP BY label} restricted to selections whose owner is an <em>active</em> account
     * (enabled, non-deleted) — the aggregate behind the admin interests console's "Selected by"
     * analytics. ONE query (never an N+1): every label's selector count comes back in a single grouped
     * scan, and the caller joins it to the catalogue rows by label.
     *
     * <p><b>Population must match the percentage denominator (TM-961).</b> The percent this count feeds
     * is {@code selectorCount / activeUsers}, where {@code activeUsers} =
     * {@link com.teammarhaba.backend.user.UserRepository#countActiveUsers()} = accounts with
     * {@code enabled = true AND deleted_at IS NULL}. So this count is scoped to the SAME population by an
     * explicit inner join to {@code users} with the identical predicate. If it counted ALL snapshots
     * (including those owned by a suspended or soft-deleted account — a {@code user_interest} row outlives
     * its owner's tombstone), a label picked only by non-active users could report a {@code selectorCount}
     * larger than {@code activeUsers} and the percentage would exceed 100% (TM-961). The join keeps
     * numerator and denominator on the same footing, so every percent is in {@code 0..100}.
     *
     * <p><b>Native query, not JPQL.</b> {@code UserInterest.userId} is a plain {@code Long}, deliberately
     * NOT a JPA association (it stays decoupled from the {@code User} aggregate's {@code @SQLRestriction}),
     * so a JPQL join could not reach {@code users} and could not honour the soft-delete restriction. A
     * native join to {@code users} spells the active predicate out directly, mirroring
     * {@code countActiveUsers()} exactly.
     *
     * <p>Keyed on the snapshot's FREE-TEXT {@code label} (TM-773), deliberately NOT on
     * {@code source_interest_id}: a selection of a since-renamed or since-retired interest is still
     * counted under the label it was picked as, which is exactly the label the catalogue row is matched
     * by. That means a retired catalogue interest still shows its historical selection count (as long as
     * the picking user is still active), and it is why the count "correctly includes selections of a
     * since-retired interest" (the ticket contract).
     *
     * <p>Returned as a lightweight {@link LabelCount} projection (label + count) rather than entities;
     * a label with zero active selections is simply absent (the caller treats a missing label as 0).
     */
    @Query(
            value =
                    "select ui.label as label, count(*) as count from user_interest ui "
                            + "join users u on u.id = ui.user_id "
                            + "where u.enabled = true and u.deleted_at is null "
                            + "group by ui.label",
            nativeQuery = true)
    List<LabelCount> selectionCountsByLabel();

    /** A single {@code (label, count)} tally row from {@link #selectionCountsByLabel()} (TM-832). */
    interface LabelCount {
        String getLabel();

        long getCount();
    }
}
