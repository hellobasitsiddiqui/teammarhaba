package com.teammarhaba.backend.membership;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;

/**
 * One subscription charge attempt (TM-620): a row in the recurring-billing ledger — what was (to be)
 * charged, through which provider order, for which paid window, and how it ended. This is the admin's
 * per-user billing history and the webhook reconciliation record for subscription payments (the
 * subscription counterpart of the per-event {@link Order}, which stays event-only).
 *
 * <p>Schema is owned by Flyway ({@code V38__create_subscriptions}); Hibernate runs validate-only, so
 * this mapping must match the {@code subscription_charges} table exactly. Keyed by {@code userId}
 * rather than a subscription FK so history survives a re-subscribe resetting the one
 * {@link Subscription} row.
 *
 * <ul>
 *   <li>{@link Kind#INITIAL} — the Subscribe checkout's first charge: paid in-browser through the
 *       Revolut widget (SCA/3DS), confirmed {@code PENDING → PAID} by the provider webhook, which
 *       activates the subscription.</li>
 *   <li>{@link Kind#RENEWAL} — an off-session merchant-initiated charge by the renewal scheduler:
 *       settled synchronously by the pay-order call ({@code PAID}/{@code FAILED}); the webhook is the
 *       idempotent backstop that can also heal a {@code FAILED} row the provider later reports paid.</li>
 * </ul>
 */
@Entity
@Table(name = "subscription_charges")
public class SubscriptionCharge {

    /** What kind of charge this is — the first in-browser payment, or an off-session renewal. */
    public enum Kind {
        /** The Subscribe checkout's first charge (widget + SCA; card saved for merchant use). */
        INITIAL,
        /** A scheduler-driven off-session renewal charge against the saved card. */
        RENEWAL
    }

    /** Where the charge attempt stands. Serialised by {@code name()} — add values, never rename. */
    public enum Status {
        /** Created; the money has not been confirmed yet (INITIAL awaiting the webhook). */
        PENDING,
        /** The money settled — the paid window this row covers was bought. */
        PAID,
        /** The charge declined/failed — a dunning datapoint (a later webhook may still heal it to PAID). */
        FAILED,
        /**
         * A checkout walked away from this attempt but the best-effort provider void was REFUSED
         * (TM-625) — usually because the order is mid-payment or already completed in another tab. The
         * provider refs are KEPT on this row so a late settle webhook still resolves here (activating
         * the subscription, or flagging the duplicate money {@link #REFUND_DUE}) instead of matching no
         * ledger and being silently acknowledged — the original captured-money-with-no-record defect.
         */
        SUPERSEDED,
        /**
         * Real money settled on this charge but the service it bought cannot be delivered (TM-625) —
         * e.g. a superseded order's late settle arriving after the replacement already activated. The
         * customer is owed the money back; the row stays here until the provider refund succeeds
         * (retried by {@code RefundSweepService}).
         */
        REFUND_DUE,
        /** The owed refund was issued at the provider (TM-625). Terminal — nothing further is owed. */
        REFUNDED
    }

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false, updatable = false)
    private Long userId;

    @Enumerated(EnumType.STRING)
    @Column(name = "kind", nullable = false)
    private Kind kind;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false)
    private Status status;

    /** The tier this charge buys a month of — recorded at charge time so price changes never rewrite history. */
    @Enumerated(EnumType.STRING)
    @Column(name = "tier", nullable = false)
    private MembershipTier tier;

    /** The charge in pence (minor units, GBP) at charge time (999 / 1999). */
    @Column(name = "amount_pence", nullable = false)
    private int amountPence;

    /** Which payment gateway the charge went to ({@code "revolut"}). */
    @Column(name = "provider")
    private String provider;

    /** The provider's permanent order id — the webhook match key ({@code V38} partial-unique index). */
    @Column(name = "provider_order_id")
    private String providerOrderId;

    /**
     * The provider customer the charge's order was created against — carried on the INITIAL charge so
     * the webhook-driven activation knows which customer the saved card lives on (the subscription row
     * may not exist yet when the charge is created).
     */
    @Column(name = "provider_customer_id")
    private String providerCustomerId;

    /** Start of the paid window this charge covers; {@code null} on an INITIAL charge until it settles. */
    @Column(name = "period_start")
    private Instant periodStart;

    /** End of the paid window this charge covers; {@code null} on an INITIAL charge until it settles. */
    @Column(name = "period_end")
    private Instant periodEnd;

    /** DB-authoritative creation timestamp ({@code DEFAULT now()}); read-only on the entity. */
    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private Instant createdAt;

    /** App-managed: set on insert and bumped on every status change. */
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    /** Optimistic-lock counter; Hibernate bumps it on update and rejects stale writes. */
    @Version
    @Column(name = "version", nullable = false)
    private long version;

    /** Required by JPA. */
    protected SubscriptionCharge() {}

    /** A new PENDING charge attempt for {@code userId} buying a month of {@code tier} at {@code amountPence}. */
    public SubscriptionCharge(Long userId, Kind kind, MembershipTier tier, int amountPence, Instant now) {
        this.userId = userId;
        this.kind = kind;
        this.status = Status.PENDING;
        this.tier = tier;
        this.amountPence = amountPence;
        this.updatedAt = now;
    }

    /** Record which provider order (and customer) carries this charge — the webhook match key. */
    public void setPaymentReference(String provider, String providerOrderId, String providerCustomerId, Instant now) {
        this.provider = provider;
        this.providerOrderId = providerOrderId;
        this.providerCustomerId = providerCustomerId;
        this.updatedAt = now;
    }

    /**
     * Re-point a still-PENDING INITIAL charge at a fresh checkout attempt (TM-620): the provider token
     * is single-use, so a caller re-entering the Subscribe checkout gets a NEW provider order — this row
     * is reused (updated in place) rather than accumulating an abandoned-PENDING row per attempt. The
     * tier/amount may change too (the caller may have picked the other tier this time round).
     */
    public void repointInitialAttempt(MembershipTier tier, int amountPence, Instant now) {
        this.tier = tier;
        this.amountPence = amountPence;
        this.provider = null;
        this.providerOrderId = null;
        this.providerCustomerId = null;
        this.updatedAt = now;
    }

    /**
     * Stamp the paid window this charge is INTENDED to buy, before the money moves (TM-620). The renewal
     * engine sets it at creation so a charge that fails synchronously but settles later via webhook
     * still knows exactly which window it bought (the heal path compares it to the current period).
     */
    public void coverPeriod(Instant periodStart, Instant periodEnd, Instant now) {
        this.periodStart = periodStart;
        this.periodEnd = periodEnd;
        this.updatedAt = now;
    }

    /**
     * The money settled: mark PAID and stamp the paid-for window. Idempotent-by-caller: only invoked on
     * a not-yet-PAID row ({@code SubscriptionService.confirmCharge} / the renewal engine check first).
     * A FAILED row may transition to PAID — a charge the sync path saw decline but the provider's
     * webhook later reports settled is real money, and the subscription is healed accordingly.
     */
    public void markPaid(Instant periodStart, Instant periodEnd, Instant now) {
        this.status = Status.PAID;
        this.periodStart = periodStart;
        this.periodEnd = periodEnd;
        this.updatedAt = now;
    }

    /** The charge declined/failed — the dunning path's datapoint. The window it would have bought is kept. */
    public void markFailed(Instant now) {
        this.status = Status.FAILED;
        this.updatedAt = now;
    }

    /**
     * The checkout re-pointed away from this attempt but its provider order could NOT be voided
     * (TM-625): keep the provider refs on this row — frozen, out of the PENDING idempotency lookup —
     * so a late settle of the maybe-still-capturable old order resolves to a ledger row instead of
     * being silently dropped. Contrast {@link #repointInitialAttempt}, which is only safe after a
     * SUCCESSFUL void (a voided order can never settle, so its refs may be forgotten).
     */
    public void markSuperseded(Instant now) {
        this.status = Status.SUPERSEDED;
        this.updatedAt = now;
    }

    /**
     * Money settled on this charge that bought nothing deliverable (TM-625) — the customer is owed it
     * back. The row stays {@code REFUND_DUE} until a provider refund succeeds; the sweeper retries.
     */
    public void markRefundDue(Instant now) {
        this.status = Status.REFUND_DUE;
        this.updatedAt = now;
    }

    /**
     * The owed refund was issued at the provider (TM-625): {@code REFUND_DUE → REFUNDED}, terminal.
     * Only called after the provider accepted the refund — a failed refund keeps the row
     * {@code REFUND_DUE} so the debt stays visible and retryable.
     */
    public void markRefunded(Instant now) {
        this.status = Status.REFUNDED;
        this.updatedAt = now;
    }

    public Long getId() {
        return id;
    }

    public Long getUserId() {
        return userId;
    }

    public Kind getKind() {
        return kind;
    }

    public Status getStatus() {
        return status;
    }

    public MembershipTier getTier() {
        return tier;
    }

    public int getAmountPence() {
        return amountPence;
    }

    public String getProvider() {
        return provider;
    }

    public String getProviderOrderId() {
        return providerOrderId;
    }

    public String getProviderCustomerId() {
        return providerCustomerId;
    }

    public Instant getPeriodStart() {
        return periodStart;
    }

    public Instant getPeriodEnd() {
        return periodEnd;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}
