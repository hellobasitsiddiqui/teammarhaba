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
import org.hibernate.annotations.Generated;

/**
 * A checkout order (TM-477): the durable record of one (user, event) commitment — what it cost and where
 * it stands. Created when RSVP goes through checkout: {@code FREE}/{@code INCLUDED} land a £0
 * {@link OrderStatus#CONFIRMED} order (frictionless), {@code PAY} lands a {@link OrderStatus#PENDING}
 * order for the Revolut path (TM-478) to settle. An in-window cancel reverses it to
 * {@link OrderStatus#CANCELLED} (or {@link OrderStatus#REFUND_DUE} when money was taken).
 *
 * <p>Schema is owned by Flyway ({@code V36__create_orders}); Hibernate runs validate-only, so this
 * mapping must match the table exactly. The table is named {@code orders} (not the SQL-reserved word
 * {@code order}). {@code userId}/{@code eventId} are plain FK ids, not JPA associations — the same
 * decoupling-from-{@code @SQLRestriction} convention as {@link Membership} and {@code EventAttendance}.
 *
 * <p><strong>Idempotency.</strong> The DB enforces {@code UNIQUE (user_id, event_id)} — one order per
 * (user, event). A repeat checkout returns the existing row rather than inserting a duplicate, and a
 * first-request race collapses to a single order (the loser trips the constraint and re-reads the
 * winner). {@code @Version} gives the usual optimistic-lock 409 so two concurrent cancels can't both
 * reverse the same order.
 */
@Entity
@Table(name = "orders")
public class Order {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false, updatable = false)
    private Long userId;

    @Column(name = "event_id", nullable = false, updatable = false)
    private Long eventId;

    /** What the commitment cost in pence (minor units, GBP); {@code 0} for FREE/INCLUDED. Never negative. */
    @Column(name = "amount_pence", nullable = false, updatable = false)
    private int amountPence;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false)
    private OrderStatus status;

    /**
     * Which payment provider holds the money for a PAY order ({@code "revolut"}); {@code null} for a
     * FREE/INCLUDED £0 order that never touched a gateway (TM-478, {@code V37}). Set once, on the PAY
     * checkout branch, alongside {@link #providerOrderId}.
     */
    @Column(name = "provider")
    private String provider;

    /**
     * The provider's <b>permanent</b> order id for a PAY order (Revolut order UUID); {@code null} for a
     * £0 order (TM-478, {@code V37}). The key an inbound webhook is matched back on (unique, partial) and
     * the handle a later refund/reconcile uses. Set once, on the PAY checkout branch.
     */
    @Column(name = "provider_order_id")
    private String providerOrderId;

    /**
     * DB-authoritative creation timestamp ({@code DEFAULT now()}); read-only on the entity.
     * {@code @Generated} (TM-629) makes Hibernate read the DB-assigned value back on insert: without it
     * a just-persisted order still had {@code createdAt == null} inside the checkout transaction, so
     * every FRESH {@code POST /events/{id}/checkout} response serialised {@code "createdAt": null}
     * while idempotent repeats and {@code GET /me/orders} carried the real timestamp — an inconsistent
     * wire shape {@link OrderView}'s contract ("never on a row read back") mispredicted.
     */
    @Generated
    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private Instant createdAt;

    /**
     * How many times the {@code RefundSweepService} has retried the provider refund for a
     * {@code REFUND_DUE} order (TM-726). Bumped on each failed sweep attempt; once it crosses the sweep's
     * cap the order is abandoned ({@link OrderStatus#REFUND_ABANDONED}) so a permanently-rejected refund is
     * not retried forever. Not touched by the inline best-effort refund at issue time.
     */
    @Column(name = "refund_attempts", nullable = false)
    private int refundAttempts;

    /** App-managed: set on insert and bumped on every {@linkplain #reverse status change}. */
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    /** Optimistic-lock counter; Hibernate bumps it on update and rejects stale writes. */
    @Version
    @Column(name = "version", nullable = false)
    private long version;

    /** Required by JPA. */
    protected Order() {
    }

    /**
     * A new order for {@code userId} on {@code eventId} at {@code amountPence}, in the given starting
     * {@code status} ({@link OrderStatus#CONFIRMED} for free/included, {@link OrderStatus#PENDING} for
     * pay). {@code now} stamps {@code updated_at}; {@code created_at} is filled by the DB default.
     */
    public Order(Long userId, Long eventId, int amountPence, OrderStatus status, Instant now) {
        this.userId = userId;
        this.eventId = eventId;
        this.amountPence = amountPence;
        this.status = status;
        this.updatedAt = now;
    }

    public Long getId() {
        return id;
    }

    public Long getUserId() {
        return userId;
    }

    public Long getEventId() {
        return eventId;
    }

    public int getAmountPence() {
        return amountPence;
    }

    public OrderStatus getStatus() {
        return status;
    }

    public String getProvider() {
        return provider;
    }

    public String getProviderOrderId() {
        return providerOrderId;
    }

    /**
     * Record the payment provider + its permanent order id on a PAY order (TM-478), set once when the
     * checkout PAY branch creates the provider order. This is what an inbound webhook is matched back on
     * (PENDING → CONFIRMED) and what a later refund/reconcile uses.
     */
    public void setPaymentReference(String provider, String providerOrderId) {
        this.provider = provider;
        this.providerOrderId = providerOrderId;
    }

    /**
     * Bump {@code updated_at} without a status change (TM-739) — used when a still-PENDING order is resumed
     * and a fresh provider reference is minted onto it, so the row records the resume.
     */
    public void touch(Instant when) {
        this.updatedAt = when;
    }

    /**
     * Settle a PAY order on a verified payment webhook (TM-478): {@code PENDING → CONFIRMED}. Only a
     * still-{@code PENDING} order transitions — a repeat webhook for an already-{@code CONFIRMED} (or
     * reversed) order is a no-op, so a redelivered notification never double-confirms or resurrects a
     * cancelled order. Returns {@code true} iff this call actually confirmed the order (so the caller
     * performs the held-back RSVP exactly once), {@code false} when there was nothing to do.
     */
    public boolean confirmPaid(Instant when) {
        if (status != OrderStatus.PENDING) {
            return false;
        }
        this.status = OrderStatus.CONFIRMED;
        this.updatedAt = when;
        return true;
    }

    /**
     * Mark a PAY order {@code FAILED} on a verified decline/fail webhook (TM-634): {@code PENDING → FAILED}.
     * Only a still-{@code PENDING} order transitions — a repeat delivery, or a decline arriving for an
     * already {@code CONFIRMED}/{@code CANCELLED}/{@code EXPIRED} order, is a no-op. A declined payment
     * captured no money, so this order never owes a refund and the held-back RSVP is never performed.
     * Returns {@code true} iff this call actually failed the order.
     */
    public boolean failPending(Instant when) {
        if (status != OrderStatus.PENDING) {
            return false;
        }
        this.status = OrderStatus.FAILED;
        this.updatedAt = when;
        return true;
    }

    /**
     * Expire an abandoned unpaid PAY order the TTL sweep found still {@code PENDING} past the abandon
     * window (TM-634): {@code PENDING → EXPIRED}. Only a still-{@code PENDING} order transitions, so a
     * settle/decline/cancel that landed while the sweep waited for the lock leaves it untouched. No money
     * captured on a {@code PENDING} order, so nothing is owed back here — but the sweep voids the provider
     * order best-effort and a late settle of a payment that captured just before expiry is caught by
     * {@link #confirmPaid}'s settle-after-terminal race handling (flagged {@code REFUND_DUE} + refunded).
     * Returns {@code true} iff this call actually expired the order.
     */
    public boolean expirePending(Instant when) {
        if (status != OrderStatus.PENDING) {
            return false;
        }
        this.status = OrderStatus.EXPIRED;
        this.updatedAt = when;
        return true;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    /** {@code true} while this order can still be reversed — it has not already been cancelled/refunded. */
    public boolean isReversible() {
        return status == OrderStatus.PENDING || status == OrderStatus.CONFIRMED;
    }

    /**
     * {@code true} for a <em>terminal, non-attending</em> order — one that ended without a live RSVP and
     * captured no money that is still ours to keep: a declined initial payment ({@link OrderStatus#FAILED}),
     * an abandoned/TTL-swept checkout ({@link OrderStatus#EXPIRED}), or an in-window cancel of an unpaid
     * order ({@link OrderStatus#CANCELLED}). These are the states a fresh checkout for the same (user, event)
     * may re-open (TM-739): the buyer has no place held and owes nothing, so barring them from ever paying
     * again — as the unconditional idempotency short-circuit did — silently killed a willing purchase.
     *
     * <p>Deliberately excludes {@link OrderStatus#CONFIRMED} (a live commitment — re-checkout stays a no-op),
     * {@link OrderStatus#REFUND_DUE}/{@link OrderStatus#REFUNDED}/{@link OrderStatus#REFUND_ABANDONED} (a
     * refund is in flight or a money-owed debt is unresolved — re-opening would race the refund bookkeeping).
     */
    public boolean isTerminalNonAttending() {
        return status == OrderStatus.FAILED
                || status == OrderStatus.EXPIRED
                || status == OrderStatus.CANCELLED;
    }

    /**
     * Re-open this terminal order back to {@link OrderStatus#PENDING} for a fresh PAY checkout (TM-739),
     * clearing the previous provider reference so a new provider order + token can be minted onto the same
     * row. The {@code UNIQUE (user_id, event_id)} constraint means we cannot insert a second order for this
     * pair, so a re-checkout after a FAILED/EXPIRED/CANCELLED order re-uses this very row rather than a new
     * one. Guarded to {@linkplain #isTerminalNonAttending terminal-non-attending} states so a live/settled
     * order can never be silently reset. Returns {@code true} iff this call actually re-opened the order.
     */
    public boolean reopenForCheckout(Instant when) {
        if (!isTerminalNonAttending()) {
            return false;
        }
        this.status = OrderStatus.PENDING;
        this.provider = null;
        this.providerOrderId = null;
        this.updatedAt = when;
        return true;
    }

    /**
     * Re-open this terminal order straight to {@link OrderStatus#CONFIRMED} for a fresh FREE/INCLUDED
     * checkout (TM-739), clearing any stale provider reference. The £0 frictionless path never touches a
     * provider, so there is no token to mint — the RSVP is confirmed by the caller in the same transaction.
     * {@code amount_pence} is {@code updatable = false} at the mapping (the original charge is immutable),
     * so this keeps the row's recorded amount; a FREE/INCLUDED terminal order was already £0. Guarded to
     * terminal-non-attending states. Returns {@code true} iff this call actually re-opened the order.
     */
    public boolean reopenConfirmed(Instant when) {
        if (!isTerminalNonAttending()) {
            return false;
        }
        this.status = OrderStatus.CONFIRMED;
        this.provider = null;
        this.providerOrderId = null;
        this.updatedAt = when;
        return true;
    }

    /**
     * Reverse this order on an in-window cancel (TM-477): a settled order where real money was captured
     * ({@code CONFIRMED} with a non-zero amount) moves to {@link OrderStatus#REFUND_DUE} — the money
     * refund itself is TM-478's job — while a £0 order or a still-{@code PENDING} pay order (no charge
     * captured) simply moves to {@link OrderStatus#CANCELLED}. Any first-event credit is returned by the
     * caller ({@code CheckoutService}) in the same transaction; this only flips the order's own state.
     */
    public void reverse(Instant when) {
        this.status = (status == OrderStatus.CONFIRMED && amountPence > 0)
                ? OrderStatus.REFUND_DUE
                : OrderStatus.CANCELLED;
        this.updatedAt = when;
    }

    /**
     * Money was captured but the promised service cannot be delivered (TM-623): a settle-time RSVP guard
     * refused the paid attendance (event started / booking closed / age-gate / one-active-event). The
     * order owes the customer their money back — {@code REFUND_DUE} until the provider refund succeeds.
     */
    public void markRefundDue(Instant when) {
        this.status = OrderStatus.REFUND_DUE;
        this.updatedAt = when;
    }

    /**
     * The owed refund was issued at the provider (TM-623): {@code REFUND_DUE → REFUNDED}, terminal.
     * Only called after the provider accepted the refund — a failed refund keeps the order
     * {@code REFUND_DUE} so the debt stays visible and retryable.
     */
    public void markRefunded(Instant when) {
        this.status = OrderStatus.REFUNDED;
        this.updatedAt = when;
    }

    /**
     * Record one failed sweep refund attempt (TM-726): bump {@link #refundAttempts} and, once it reaches
     * {@code maxAttempts}, move the order to the terminal {@link OrderStatus#REFUND_ABANDONED} so the sweep
     * stops retrying a permanently-rejected refund. Below the cap the order stays {@code REFUND_DUE} for
     * the next pass. Returns {@code true} iff this attempt exhausted the budget (the order is now
     * abandoned).
     */
    public boolean recordFailedRefundAttempt(int maxAttempts, Instant when) {
        this.refundAttempts++;
        this.updatedAt = when;
        if (this.refundAttempts >= maxAttempts) {
            this.status = OrderStatus.REFUND_ABANDONED;
            return true;
        }
        return false;
    }

    public int getRefundAttempts() {
        return refundAttempts;
    }
}
