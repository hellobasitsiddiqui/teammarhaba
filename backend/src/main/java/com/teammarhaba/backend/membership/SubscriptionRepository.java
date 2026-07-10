package com.teammarhaba.backend.membership;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

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
     * pointer and never match. Oldest-due first and bounded, so one enormous backlog can't starve a
     * pass; the next tick picks up the remainder.
     */
    List<Subscription> findTop100ByNextChargeAtLessThanEqualOrderByNextChargeAtAsc(Instant dueBy);
}
