package com.teammarhaba.backend.interests;

import java.util.Collection;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

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
}
