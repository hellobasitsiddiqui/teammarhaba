package com.teammarhaba.backend.membership;

import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

/**
 * Data access for {@link Order} (TM-477). The (user, event) pair is the natural lookup key — the table's
 * {@code UNIQUE (user_id, event_id)} makes it at most one row — so {@link #findByUserIdAndEventId} backs
 * both the idempotency check (a repeat checkout returns the existing order) and the cancel/reverse path
 * (find the order to reverse). The unique constraint is also what collapses a concurrent first-checkout
 * race to a single order (the loser re-reads the winner), mirroring the TM-597 enrol pattern.
 */
public interface OrderRepository extends JpaRepository<Order, Long> {

    Optional<Order> findByUserIdAndEventId(Long userId, Long eventId);

    /**
     * The order that went to a payment provider under {@code providerOrderId} (TM-478) — the webhook match
     * key. The {@code V37} partial-unique index makes it at most one row, so a settled-payment webhook
     * resolves to exactly the local order to confirm (or none, if we never created it).
     */
    Optional<Order> findByProviderOrderId(String providerOrderId);

    /**
     * Every order belonging to one caller, newest first (TM-481) — the "my tickets / purchases" history.
     * Ordered by {@code createdAt} descending, with {@code id} descending as a deterministic tiebreak:
     * the DB default {@code now()} is the transaction timestamp, so two orders committed in the same
     * transaction share a {@code createdAt}, and the higher (later-inserted) id then wins — a stable
     * newest-first ordering the endpoint's contract can rely on.
     */
    List<Order> findByUserIdOrderByCreatedAtDescIdDesc(Long userId);
}
