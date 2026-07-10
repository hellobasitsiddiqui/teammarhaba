package com.teammarhaba.backend.membership;

/**
 * The lifecycle state of a checkout {@link Order} (TM-477). An order is the durable receipt of one
 * (user, event) commitment: what it cost and where it stands.
 *
 * <ul>
 *   <li>{@link #PENDING} — a {@code PAY} commitment whose charge has not settled. Created by checkout,
 *       handed to the Revolut path (TM-478) which confirms or abandons it. The RSVP is <em>not</em>
 *       confirmed while an order is pending — the caller owes money first.</li>
 *   <li>{@link #CONFIRMED} — the commitment is settled: a {@code FREE}/{@code INCLUDED} order (£0, no
 *       payment), or later a {@code PAY} order once TM-478 captures payment. The RSVP holds.</li>
 *   <li>{@link #CANCELLED} — reversed inside the cancellation window with no money to return (a £0
 *       order, or a still-{@code PENDING} pay order whose charge was never captured). Any consumed
 *       first-event credit was returned in the same transaction.</li>
 *   <li>{@link #REFUND_DUE} — reversed inside the window on an order where real money was taken: the
 *       commitment is undone here and the credit returned, but the actual money refund is TM-478's job
 *       (this slice only records that a refund is owed). No current path produces a captured-payment
 *       order, so this is the reserved state TM-478's refund flow will drive.</li>
 * </ul>
 *
 * <p>Serialised by {@code name()} (Jackson default) — a wire contract: add values, never rename.
 */
public enum OrderStatus {

    /** A PAY order awaiting payment (TM-478); the RSVP is not yet confirmed. */
    PENDING,

    /** The commitment is settled (free/included now, or a captured PAY order later). */
    CONFIRMED,

    /** Reversed in-window with nothing to refund; any first-event credit was returned. */
    CANCELLED,

    /** Reversed in-window on a paid order — a money refund is owed (issued by TM-623's refund path). */
    REFUND_DUE,

    /**
     * The owed money was returned (TM-623): the provider refund call succeeded and the commitment is
     * fully unwound. Terminal — nothing further is owed in either direction.
     */
    REFUNDED
}
