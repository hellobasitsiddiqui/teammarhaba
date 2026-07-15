package com.teammarhaba.backend.membership;

import com.teammarhaba.backend.event.RsvpResult;

/**
 * The outcome of an RSVP checkout (TM-477): the recorded {@link OrderView order}, whether payment is still
 * required, and — when the commitment confirmed frictionlessly — where the RSVP landed.
 *
 * <ul>
 *   <li><b>FREE / INCLUDED</b> — {@code paymentRequired = false}, a {@code CONFIRMED} £0 order, and a
 *       non-null {@code rsvp} (the caller is confirmed to the event, {@code GOING} or {@code WAITLISTED}).
 *       On a first-event {@code FREE}, the credit was consumed in the same transaction.</li>
 *   <li><b>PAY</b> — {@code paymentRequired = true}, a {@code PENDING} order for the amount, and a
 *       {@code null} {@code rsvp}: the RSVP is <em>not</em> confirmed until payment settles (TM-478).</li>
 *   <li><b>Idempotent repeat</b> — the existing order for this (user, event) is returned unchanged;
 *       {@code paymentRequired} reflects whether it is still {@code PENDING}, and {@code rsvp} is
 *       {@code null} (the attendance was already established by the first checkout).</li>
 * </ul>
 *
 * @param order           the order recorded (or the pre-existing one, on an idempotent repeat)
 * @param paymentRequired {@code true} when the order is {@code PENDING} and the caller still owes payment
 * @param rsvp            where the RSVP landed on a fresh frictionless confirm, else {@code null}
 * @param paymentToken    the payment provider's <b>temporary</b> client token to mount the checkout widget
 *                        (Revolut order token, TM-478) — present on a FRESH PAY commitment AND on a resume of
 *                        a still-{@code PENDING} order, where a new single-use token is minted onto the same
 *                        row so the client can re-mount the widget (TM-739). {@code null} for FREE/INCLUDED and
 *                        for a truly-idempotent repeat of a live/settled order. Null ⇒ omitted from the JSON
 *                        (global {@code NON_NULL}), so a no-charge receipt never carries the field.
 */
public record CheckoutResult(OrderView order, boolean paymentRequired, RsvpResult rsvp, String paymentToken) {

    /** A frictionless FREE/INCLUDED confirm: a CONFIRMED order and the RSVP landing; no payment token. */
    static CheckoutResult confirmed(Order order, RsvpResult rsvp) {
        return new CheckoutResult(OrderView.from(order), false, rsvp, null);
    }

    /**
     * A fresh PAY commitment: a PENDING order, "payment required", and the provider's client token so the
     * browser can mount the checkout widget (TM-478). The RSVP is NOT confirmed — it is held back until the
     * payment webhook settles the order.
     */
    static CheckoutResult paymentRequired(Order order, String paymentToken) {
        return new CheckoutResult(OrderView.from(order), true, null, paymentToken);
    }

    /**
     * A truly-idempotent repeat: the existing order, unchanged, with no fresh token. Used for a LIVE or
     * settled order — {@code CONFIRMED} (a held commitment) or a {@code REFUND_DUE}/{@code REFUNDED}/
     * {@code REFUND_ABANDONED} row whose money is still being unwound. {@code paymentRequired} follows the
     * PENDING state, which is {@code false} for all of these — the caller is not re-prompted to pay.
     *
     * <p>A still-{@code PENDING} order is <em>not</em> routed here (TM-739): re-checkout re-mints a fresh
     * provider token onto that same row via {@link #paymentRequired} so the client can resume, rather than
     * returning a "payment required" with a null token the client can never act on. A terminal
     * {@code FAILED}/{@code EXPIRED}/{@code CANCELLED} order is likewise not routed here — it is re-opened
     * for a brand-new checkout (see {@code CheckoutService.checkout}).
     */
    static CheckoutResult existing(Order order) {
        return new CheckoutResult(OrderView.from(order), order.getStatus() == OrderStatus.PENDING, null, null);
    }
}
