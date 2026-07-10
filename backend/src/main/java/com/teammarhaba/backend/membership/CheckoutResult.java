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
 */
public record CheckoutResult(OrderView order, boolean paymentRequired, RsvpResult rsvp) {

    /** A frictionless FREE/INCLUDED confirm: a CONFIRMED order and the RSVP landing. */
    static CheckoutResult confirmed(Order order, RsvpResult rsvp) {
        return new CheckoutResult(OrderView.from(order), false, rsvp);
    }

    /** A PAY commitment: a PENDING order and "payment required"; the RSVP is not yet confirmed. */
    static CheckoutResult paymentRequired(Order order) {
        return new CheckoutResult(OrderView.from(order), true, null);
    }

    /** An idempotent repeat: the existing order, unchanged; paymentRequired follows its PENDING state. */
    static CheckoutResult existing(Order order) {
        return new CheckoutResult(OrderView.from(order), order.getStatus() == OrderStatus.PENDING, null);
    }
}
