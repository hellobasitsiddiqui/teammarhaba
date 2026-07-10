package com.teammarhaba.backend.membership;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Data access for {@link Subscription} (TM-620). The account's {@code user_id} is the natural lookup
 * key (globally {@code UNIQUE} — at most one subscription per account): {@link #findByUserId} backs the
 * member-facing reads, the Subscribe checkout's "already subscribed?" guard and the
 * {@code MembershipService.switchTier} paid-tier gate.
 */
public interface SubscriptionRepository extends JpaRepository<Subscription, Long> {

    Optional<Subscription> findByUserId(Long userId);

    /**
     * The renewal scan (TM-620): every subscription whose {@code next_charge_at} "due" pointer has
     * passed — an ACTIVE row due its renewal, a PAST_DUE row due a dunning retry, or a CANCELED row
     * whose paid period just ran out (due its downgrade). Rows with nothing pending keep a {@code null}
     * pointer and never match. Oldest-due first and bounded by the caller's {@code Pageable}, so one
     * enormous backlog can't starve a pass; the next tick picks up the remainder.
     *
     * <p><strong>Soft-deleted accounts are excluded</strong> (TM-623): a tombstoned user must never be
     * charged, so their rows don't even enter the pass. The {@code User} reference in the subquery
     * carries the entity's {@code @SQLRestriction}, and the explicit {@code deletedAt is null} states
     * the same guard in the query itself (belt and braces — the restriction is easy to lose in a
     * refactor and this is money). {@code processOne} re-checks the account under the lock as well,
     * covering a deletion that lands between the scan and the charge.
     */
    @Query("""
            select s from Subscription s
            where s.nextChargeAt <= :dueBy
              and exists (select u.id from User u where u.id = s.userId and u.deletedAt is null)
            order by s.nextChargeAt asc
            """)
    List<Subscription> findDueForActiveUsers(@Param("dueBy") Instant dueBy, Pageable pageable);
}
