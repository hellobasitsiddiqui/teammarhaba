package com.teammarhaba.backend.membership;

import com.teammarhaba.backend.event.CancelResult;

/**
 * The outcome of cancelling a checkout (TM-477). The attendance is always dropped (leaving an event is
 * never gated — the caller un-RSVPs); what varies is whether the <em>commitment</em> is reversed:
 *
 * <ul>
 *   <li><b>Inside the cancellation window</b> (an early cancel, {@code cancel.lateCancel() == false}) —
 *       {@code reversed = true}: the order moves to {@code CANCELLED}/{@code REFUND_DUE} and, if this
 *       event consumed the first-event credit, {@code creditReturned = true} (the credit is available
 *       again).</li>
 *   <li><b>Missing the window</b> (a late cancel, or a no-show that never cancels) — {@code reversed =
 *       false}: the order stays {@code CONFIRMED} and the credit/charge is forfeited, even though the
 *       caller has left the event.</li>
 * </ul>
 *
 * @param reversed       whether the commitment was reversed (an in-window cancel of a reversible order)
 * @param creditReturned whether a consumed first-event credit was returned in this cancel
 * @param cancel         the underlying un-RSVP verdict (late-cancel flag, strike count, honest message)
 * @param order          the order after the cancel, or {@code null} if the caller had no order to reverse
 */
public record CheckoutCancelResult(
        boolean reversed, boolean creditReturned, CancelResult cancel, OrderView order) {

    static CheckoutCancelResult of(boolean reversed, boolean creditReturned, CancelResult cancel, Order order) {
        return new CheckoutCancelResult(
                reversed, creditReturned, cancel, order == null ? null : OrderView.from(order));
    }
}
