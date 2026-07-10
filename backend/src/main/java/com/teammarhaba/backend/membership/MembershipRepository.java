package com.teammarhaba.backend.membership;

import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

/**
 * Data access for {@link Membership} (TM-474). The account's {@code user_id} is the natural lookup key
 * (globally {@code UNIQUE} — one membership per account): {@link #findByUserId(Long)} backs both the
 * JIT get-or-enrol read and the tier switch, and the unique constraint is what collapses a concurrent
 * first-request enrol race to a single row (the loser re-reads the winner, mirroring TM-597).
 */
public interface MembershipRepository extends JpaRepository<Membership, Long> {

    Optional<Membership> findByUserId(Long userId);
}
