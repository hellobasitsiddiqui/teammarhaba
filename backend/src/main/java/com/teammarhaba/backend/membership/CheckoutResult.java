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
 *                        (Revolut order token, TM-478) — present only on a FRESH PAY commitment; {@code null}
 *                        for FREE/INCLUDED and for an idempotent repeat (the token is single-use and not
 *                        persisted, so a repeat PENDING checkout returns "payment required" without a fresh
 *                        token — the client re-initiates checkout to obtain a new one). Null ⇒ omitted from
 *                        the JSON (global {@code NON_NULL}), so a no-charge receipt never carries the field.
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
     * An idempotent repeat: the existing order, unchanged; paymentRequired follows its PENDING state. No
     * fresh token — the provider token is single-use and not stored, so a client resuming a PENDING order
     * re-initiates checkout to get a new one.
     */
    static CheckoutResult existing(Order order) {
        return new CheckoutResult(OrderView.from(order), order.getStatus() == OrderStatus.PENDING, null, null);
    }
}
