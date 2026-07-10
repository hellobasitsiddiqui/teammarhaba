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

    /** DB-authoritative creation timestamp ({@code DEFAULT now()}); read-only on the entity. */
    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private Instant createdAt;

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
}
