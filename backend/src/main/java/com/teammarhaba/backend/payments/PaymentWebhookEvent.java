package com.teammarhaba.backend.payments;

/**
 * A verified payment webhook notification (TM-478), reduced to the two facts the checkout flow acts on,
 * so the provider-specific event zoo ({@code ORDER_COMPLETED}, {@code ORDER_AUTHORISED},
 * {@code ORDER_PAYMENT_DECLINED}, …) never leaks past the {@link PaymentProvider} seam.
 *
 * <p>Only produced once the signature has been verified — an unverifiable or malformed payload yields an
 * empty {@code Optional} from {@link PaymentProvider#parseWebhookEvent}, never a {@code PaymentWebhookEvent}.
 *
 * <p><strong>Outcome, not a boolean (TM-634).</strong> This used to carry a single {@code paid} flag, which
 * folded "declined/failed" in with every other non-settle lifecycle event and left them all as an ignored
 * no-op. A declined/failed INITIAL widget payment ({@code ORDER_PAYMENT_DECLINED}/{@code ORDER_PAYMENT_FAILED})
 * must instead drive the local order to a terminal state, so the reduction now distinguishes three cases via
 * {@link Outcome}. The {@link #paid()} convenience preserves the old settle-path predicate.
 *
 * @param providerOrderId the provider's permanent order id the event is about — matched against the local
 *                        {@code Order.provider_order_id} to find the checkout to act on
 * @param outcome         what the event means for the local order (see {@link Outcome})
 */
public record PaymentWebhookEvent(String providerOrderId, Outcome outcome) {

    /** What a verified webhook event means for the local order/charge. */
    public enum Outcome {
        /**
         * The money settled — move the local record {@code PENDING → CONFIRMED}/{@code PAID} and perform the
         * held-back RSVP / activate the subscription (Revolut {@code ORDER_COMPLETED}/{@code ORDER_AUTHORISED}).
         */
        SETTLED,

        /**
         * The payment was declined or failed (TM-634) — move the local record to a terminal, non-settling
         * state ({@code FAILED}) and <em>never</em> activate membership/subscription (Revolut
         * {@code ORDER_PAYMENT_DECLINED}/{@code ORDER_PAYMENT_FAILED}). No money was captured, so nothing is
         * owed back.
         */
        FAILED,

        /**
         * Any other verified lifecycle event we do not act on (cancelled/expired/…): acknowledged with a 2xx
         * so the provider stops retrying, but the local order is left untouched.
         */
        OTHER
    }

    /** {@code true} iff the money settled — the settle path's predicate (kept from the pre-TM-634 shape). */
    public boolean paid() {
        return outcome == Outcome.SETTLED;
    }

    /** {@code true} iff the payment was declined/failed and the local order must be marked terminal (TM-634). */
    public boolean failed() {
        return outcome == Outcome.FAILED;
    }
}
