package com.teammarhaba.backend.membership;

import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

/**
 * Data access for the {@link SubscriptionCharge} billing ledger (TM-620).
 *
 * <ul>
 *   <li>{@link #findByProviderOrderId} — the webhook reconciliation key ({@code V38} partial-unique
 *       index): a settled-payment webhook resolves to at most one charge to confirm.</li>
 *   <li>{@link #findFirstByUserIdAndKindAndStatus} — the Subscribe checkout's idempotency read: a
 *       still-PENDING INITIAL charge is reused (re-pointed at a fresh provider order) rather than
 *       piling up one abandoned row per attempt.</li>
 *   <li>{@link #findTop50ByUserIdOrderByCreatedAtDescIdDesc} — the admin billing history, newest first
 *       ({@code id} desc as the deterministic same-timestamp tiebreak, mirroring the orders read).</li>
 * </ul>
 */
public interface SubscriptionChargeRepository extends JpaRepository<SubscriptionCharge, Long> {

    Optional<SubscriptionCharge> findByProviderOrderId(String providerOrderId);

    Optional<SubscriptionCharge> findFirstByUserIdAndKindAndStatus(
            Long userId, SubscriptionCharge.Kind kind, SubscriptionCharge.Status status);

    List<SubscriptionCharge> findTop50ByUserIdOrderByCreatedAtDescIdDesc(Long userId);
}
