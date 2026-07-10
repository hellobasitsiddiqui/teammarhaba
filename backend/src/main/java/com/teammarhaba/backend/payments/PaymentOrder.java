package com.teammarhaba.backend.payments;

/**
 * The result of creating a payment order with a provider (TM-478) — the two identifiers the checkout
 * flow needs, kept deliberately provider-neutral so {@link PaymentProvider} stays swappable (Revolut
 * today, Stripe tomorrow).
 *
 * @param id    the provider's <b>permanent</b> order id — persisted on the local {@code Order}
 *              ({@code provider_order_id}) and the key a webhook is matched back on. For Revolut this is
 *              the order {@code id} (a UUID); it never changes and is what you retrieve/capture/refund by.
 * @param token the <b>temporary</b> client token used to mount the checkout widget in the browser
 *              (Revolut's order {@code token}, the {@code public_id} the RevolutCheckout.js widget takes).
 *              Expires once the payment is authorised, so it is returned to the client but never persisted.
 */
public record PaymentOrder(String id, String token) {}
