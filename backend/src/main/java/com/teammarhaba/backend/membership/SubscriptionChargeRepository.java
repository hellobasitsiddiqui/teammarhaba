package com.teammarhaba.backend.membership;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Pageable;
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

    /**
     * The renewal engine's per-window idempotency read (TM-623): the latest charge attempt covering the
     * billing window that starts at {@code periodStart}. A dunning retry reuses THIS row (and its
     * provider order) instead of opening a fresh provider order per attempt — one charge unit per
     * (account, window), enforced gateway-side because an order can only be paid once. Newest first
     * ({@code id} desc) in case historical data ever holds several rows for one window.
     */
    Optional<SubscriptionCharge> findFirstByUserIdAndKindAndPeriodStartOrderByIdDesc(
            Long userId, SubscriptionCharge.Kind kind, java.time.Instant periodStart);

    /**
     * The renewal engine's catch-up idempotency backstop (TM-625): the user's latest charge of
     * {@code kind} in one of {@code statuses} (open attempts — PENDING/FAILED) that already carries a
     * provider order. The catch-up branch re-anchors {@code periodStart} at "now" on EVERY attempt, so
     * the exact-window lookup above can never see a previous catch-up attempt — this query finds that
     * in-flight attempt regardless of its window, so the retry pays the SAME gateway-idempotent order
     * instead of opening (and paying) a second one for the same effective month.
     */
    Optional<SubscriptionCharge> findFirstByUserIdAndKindAndStatusInAndProviderOrderIdIsNotNullOrderByIdDesc(
            Long userId, SubscriptionCharge.Kind kind, Collection<SubscriptionCharge.Status> statuses);

    /**
     * The refund sweep's scan (TM-625): every charge sitting in {@code status} (in practice
     * {@code REFUND_DUE}), oldest first, bounded by the caller's page. Backed by the {@code V39}
     * partial index so the sweep never table-scans the ledger.
     */
    List<SubscriptionCharge> findByStatusOrderByIdAsc(SubscriptionCharge.Status status, Pageable pageable);

    List<SubscriptionCharge> findTop50ByUserIdOrderByCreatedAtDescIdDesc(Long userId);
}
