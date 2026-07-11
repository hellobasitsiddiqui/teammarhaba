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
import java.time.OffsetDateTime;
import java.time.ZoneOffset;

/**
 * An account's recurring membership subscription (TM-620 / epic Membership): the durable record of a
 * monthly charge against a saved card for a paid tier (MONTHLY £9.99 / DIAMOND £19.99). At most one
 * row per account ({@code UNIQUE user_id}) — re-subscribing after a cancel RESETS this row (the
 * {@link SubscriptionCharge} ledger keeps the history).
 *
 * <p>Schema is owned by Flyway ({@code V38__create_subscriptions}); Hibernate runs validate-only, so
 * this mapping must match the table exactly. {@code userId} is a plain FK id, not a JPA association —
 * the same decoupling convention as {@link Membership} and {@link Order}.
 *
 * <p><strong>The one "due" pointer.</strong> {@link #getNextChargeAt() nextChargeAt} is when the
 * renewal scheduler must next act on this row, whatever the action is: the period end for an
 * {@code ACTIVE} row (charge the renewal), the dunning retry time for a {@code PAST_DUE} row (retry
 * the charge), the period end for a user-{@code CANCELED} row (downgrade the tier), and {@code null}
 * when nothing is pending. The scheduler's whole scan is "rows whose nextChargeAt has passed".
 *
 * <p><strong>Anniversary billing.</strong> The cycle is rolling from the subscribe date: every renewal
 * advances the period by one calendar month <em>from the previous period end</em> (see
 * {@link #plusOneMonth}), never from the charge time — so a dunning-delayed charge cannot drift the
 * anniversary. Subscribing on the 31st clamps to the shorter months' last day (standard
 * {@code plusMonths} semantics), which is the industry-normal behaviour.
 *
 * <p>Optimistic concurrency via {@code @Version}: a webhook confirm racing a scheduler pass on the
 * same row fails the second writer (409 / retried next tick) rather than silently overwriting.
 */
@Entity
@Table(name = "subscriptions")
public class Subscription {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false, unique = true, updatable = false)
    private Long userId;

    /** The paid tier this subscription pays for ({@code MONTHLY} or {@code DIAMOND} — never the free base). */
    @Enumerated(EnumType.STRING)
    @Column(name = "tier", nullable = false)
    private MembershipTier tier;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false)
    private SubscriptionStatus status;

    /** Start of the currently paid-for window (the previous period end, or the subscribe instant). */
    @Column(name = "current_period_start", nullable = false)
    private Instant currentPeriodStart;

    /** End of the currently paid-for window — the renewal anchor and the entitlement horizon on cancel. */
    @Column(name = "current_period_end", nullable = false)
    private Instant currentPeriodEnd;

    /**
     * The provider's saved payment-method id (Revolut payment-method UUID saved for MERCHANT use) that
     * off-session renewals charge; {@code null} until the save is confirmed after the first checkout —
     * a renewal with no stored ref re-fetches it from the provider before charging.
     */
    @Column(name = "saved_payment_method_ref")
    private String savedPaymentMethodRef;

    /** Which payment gateway holds the mandate ({@code "revolut"}) — mirrors {@code orders.provider}. */
    @Column(name = "provider")
    private String provider;

    /** The provider's customer id the saved card hangs off — renewal orders are created against it. */
    @Column(name = "provider_customer_id")
    private String providerCustomerId;

    /** When the scheduler must next act on this row; {@code null} = nothing pending (see class doc). */
    @Column(name = "next_charge_at")
    private Instant nextChargeAt;

    /** Dunning retries attempted in the current past-due episode; reset on every successful charge. */
    @Column(name = "retry_count", nullable = false)
    private int retryCount;

    /** When renewals were stopped (user cancel or dunning lapse); {@code null} while renewing. */
    @Column(name = "canceled_at")
    private Instant canceledAt;

    /** DB-authoritative creation timestamp ({@code DEFAULT now()}); read-only on the entity. */
    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private Instant createdAt;

    /** App-managed: set on activate and bumped on every state change. */
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    /** Optimistic-lock counter; Hibernate bumps it on update and rejects stale writes. */
    @Version
    @Column(name = "version", nullable = false)
    private long version;

    /** Required by JPA. */
    protected Subscription() {}

    /**
     * A brand-new ACTIVE subscription for {@code userId}, starting a rolling monthly cycle at
     * {@code now} (the settle time of the first charge — the anniversary anchor).
     *
     * @param userId             the account being subscribed
     * @param tier               the paid tier bought ({@code MONTHLY}/{@code DIAMOND})
     * @param provider           the payment gateway name ({@code "revolut"})
     * @param providerCustomerId the provider customer the saved card belongs to
     * @param now                the activation instant — period start and the renewal anchor
     */
    public Subscription(Long userId, MembershipTier tier, String provider, String providerCustomerId, Instant now) {
        this.userId = userId;
        activate(tier, provider, providerCustomerId, now);
    }

    /**
     * (Re)activate this subscription onto {@code tier} with a fresh rolling period starting {@code now}
     * (TM-620). Used both by the constructor (first subscribe) and by a re-subscribe after a cancel/lapse
     * — the row resets to a clean ACTIVE state and a new anniversary; any previous dunning state is
     * cleared. The saved-method ref is cleared too: the new checkout saves a (possibly different) card,
     * which the activation confirm re-resolves from the provider.
     *
     * <p><strong>Residual paid time is credited, never forfeited (TM-629).</strong> A CANCELED
     * subscription may re-subscribe immediately, but its old paid window can still have days left —
     * previously the reset simply swallowed them, so "cancel day 1, re-subscribe day 2" paid twice for
     * the overlap. The unexpired remainder is carried over: the fresh period ends one month from
     * {@code now} <em>plus</em> whatever was still paid for. (A lapsed/PAST_DUE row's period end is
     * already in the past, so nothing is added there.)
     */
    public void activate(MembershipTier tier, String provider, String providerCustomerId, Instant now) {
        java.time.Duration residual = java.time.Duration.ZERO;
        if (this.status == SubscriptionStatus.CANCELED
                && this.currentPeriodEnd != null
                && this.currentPeriodEnd.isAfter(now)) {
            residual = java.time.Duration.between(now, this.currentPeriodEnd);
        }
        this.tier = tier;
        this.status = SubscriptionStatus.ACTIVE;
        this.currentPeriodStart = now;
        this.currentPeriodEnd = plusOneMonth(now).plus(residual);
        this.provider = provider;
        this.providerCustomerId = providerCustomerId;
        this.savedPaymentMethodRef = null;
        this.nextChargeAt = this.currentPeriodEnd;
        this.retryCount = 0;
        this.canceledAt = null;
        this.updatedAt = now;
    }

    /**
     * A successful renewal charge (TM-620): roll the paid window forward one month from the previous
     * period END (anniversary billing — never from the charge time), return to ACTIVE and clear any
     * dunning state. The next charge is due at the new period end.
     */
    public void extendPeriod(Instant now) {
        extendPeriodTo(this.currentPeriodEnd, plusOneMonth(this.currentPeriodEnd), now);
    }

    /**
     * Grant an explicitly-bounded paid window (TM-623) — the charge-stamped window the webhook heal
     * settles, or a catch-up window the renewal engine re-anchored at "now" after a long scheduler gap.
     *
     * <p><strong>A CANCELED subscription stays CANCELED.</strong> Extending the paid window is about
     * money that really moved (the user gets the time they paid for); flipping the row back to ACTIVE
     * would silently resurrect auto-renewal against a card whose owner explicitly withdrew consent —
     * the exact TM-623 healRenewal bug. A CANCELED row therefore keeps its status and {@code canceledAt},
     * with {@code nextChargeAt} parked at the NEW period end as the downgrade pointer (the scheduler
     * ends the tier when the healed window runs out, charging nothing). Only ACTIVE/PAST_DUE rows
     * return to ACTIVE.
     */
    public void extendPeriodTo(Instant newStart, Instant newEnd, Instant now) {
        this.currentPeriodStart = newStart;
        this.currentPeriodEnd = newEnd;
        if (this.status != SubscriptionStatus.CANCELED) {
            this.status = SubscriptionStatus.ACTIVE;
        }
        // ACTIVE: the next renewal charge. CANCELED: the downgrade pass. Both live at the period end.
        this.nextChargeAt = this.currentPeriodEnd;
        this.retryCount = 0;
        this.updatedAt = now;
    }

    /**
     * A failed renewal charge entering (or continuing) dunning (TM-620): mark PAST_DUE, count the
     * attempt and schedule the next retry. The paid tier is KEPT while dunning lasts — the retries are
     * the grace period the product decision grants.
     *
     * @param nextRetryAt when the scheduler should attempt the charge again
     */
    public void markPastDue(Instant nextRetryAt, Instant now) {
        this.status = SubscriptionStatus.PAST_DUE;
        this.retryCount++;
        this.nextChargeAt = nextRetryAt;
        this.updatedAt = now;
    }

    /**
     * A user cancel (TM-620): stop future renewals but honour the paid-for time — the tier survives
     * until {@code currentPeriodEnd}, when the scheduler (whose "due" pointer is parked exactly there)
     * downgrades the membership to pay-per-event. Idempotent by the caller's check (cancelling an
     * already-CANCELED subscription is a no-op upstream).
     */
    public void cancelAtPeriodEnd(Instant now) {
        this.status = SubscriptionStatus.CANCELED;
        this.canceledAt = now;
        this.nextChargeAt = this.currentPeriodEnd;
        this.updatedAt = now;
    }

    /**
     * Terminal lapse (TM-620): dunning exhausted (or a canceled period reached its end) — renewals are
     * over and nothing is pending any more. The membership downgrade itself is the caller's job
     * ({@code SubscriptionRenewalService}), done in the same transaction.
     */
    public void lapse(Instant now) {
        this.status = SubscriptionStatus.CANCELED;
        if (this.canceledAt == null) {
            this.canceledAt = now;
        }
        this.nextChargeAt = null;
        this.updatedAt = now;
    }

    /**
     * Whether this subscription still entitles the account to its paid tier at {@code at} (TM-620):
     * ACTIVE and PAST_DUE always do (dunning keeps the tier), and a CANCELED one does until its paid-for
     * period runs out. This is the gate {@code MembershipService.switchTier} checks before letting a
     * caller switch INTO a paid tier.
     */
    public boolean isEntitledAt(Instant at) {
        return switch (status) {
            case ACTIVE, PAST_DUE -> true;
            case CANCELED -> currentPeriodEnd.isAfter(at);
        };
    }

    /** Whether renewals are still running (ACTIVE or dunning) — i.e. the user has NOT cancelled/lapsed. */
    public boolean isRenewing() {
        return status == SubscriptionStatus.ACTIVE || status == SubscriptionStatus.PAST_DUE;
    }

    /** Record the provider's merchant-saved payment method the renewals will charge. */
    public void savePaymentMethodRef(String ref, Instant now) {
        this.savedPaymentMethodRef = ref;
        this.updatedAt = now;
    }

    /**
     * One calendar month later, in UTC — the rolling-anniversary step. {@code plusMonths} clamps
     * day-of-month overflow (Jan 31 → Feb 28/29), the standard subscription-billing convention.
     */
    static Instant plusOneMonth(Instant instant) {
        return OffsetDateTime.ofInstant(instant, ZoneOffset.UTC).plusMonths(1).toInstant();
    }

    public Long getId() {
        return id;
    }

    public Long getUserId() {
        return userId;
    }

    public MembershipTier getTier() {
        return tier;
    }

    public SubscriptionStatus getStatus() {
        return status;
    }

    public Instant getCurrentPeriodStart() {
        return currentPeriodStart;
    }

    public Instant getCurrentPeriodEnd() {
        return currentPeriodEnd;
    }

    public String getSavedPaymentMethodRef() {
        return savedPaymentMethodRef;
    }

    public String getProvider() {
        return provider;
    }

    public String getProviderCustomerId() {
        return providerCustomerId;
    }

    public Instant getNextChargeAt() {
        return nextChargeAt;
    }

    public int getRetryCount() {
        return retryCount;
    }

    public Instant getCanceledAt() {
        return canceledAt;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}
