package com.teammarhaba.backend.payments;

import java.util.Optional;

/**
 * The payment-gateway seam (TM-478): everything the membership checkout needs from a payment provider,
 * kept small and provider-neutral so the concrete gateway is a drop-in swap. Revolut is the shipped
 * implementation ({@link RevolutPaymentProvider}); a Stripe adapter would implement the same two
 * operations and nothing above this interface would change (the checkout decision, the {@code Order}
 * record, and the webhook wiring are all provider-agnostic).
 *
 * <p>Two operations, mirroring the two halves of a card payment:
 *
 * <ol>
 *   <li><b>create</b> — {@link #createOrder} opens a payment order for an amount and hands back the ids
 *       the flow needs: the permanent id to persist + reconcile on, and the temporary client token the
 *       browser widget mounts with.</li>
 *   <li><b>confirm</b> — {@link #parseWebhookEvent} verifies an inbound webhook's signature and reduces it
 *       to "which order, and did it settle?", so the confirm path can move the local order to CONFIRMED
 *       and perform the RSVP. Signature verification lives behind this seam because the header names +
 *       HMAC construction are provider-specific.</li>
 * </ol>
 */
public interface PaymentProvider {

    /**
     * The stable provider identifier persisted on the {@code Order} ({@code provider} column), e.g.
     * {@code "revolut"}. Lets a later reconciliation/refund path route back to the right adapter and makes
     * the order record self-describing about which gateway holds the money.
     */
    String name();

    /**
     * Open a payment order for {@code amountMinor} in {@code currency} (TM-478). Called server-side on the
     * PAY checkout branch; the returned {@link PaymentOrder#id() id} is persisted on the local order and
     * the {@link PaymentOrder#token() token} is returned to the client to mount the checkout widget.
     *
     * @param amountMinor the charge in <b>minor units</b> (pence for GBP) — the {@code Order.amountPence}
     *                    is already in this unit, so it is passed straight through
     * @param currency    the ISO-4217 currency code (e.g. {@code GBP})
     * @param reference   an opaque merchant reference for reconciliation (the local order id as text); the
     *                    adapter may attach it to the provider order or ignore it
     * @return the created order's permanent id + temporary client token
     * @throws PaymentProviderException if the provider rejects the request or is unreachable — the caller's
     *                                  transaction rolls back, leaving no orphan local order
     */
    PaymentOrder createOrder(int amountMinor, String currency, String reference);

    /**
     * Verify and interpret an inbound webhook (TM-478). Returns the reduced {@link PaymentWebhookEvent}
     * only when the signature checks out and the body is a recognised order event; returns
     * {@link Optional#empty()} for a bad/absent signature, an unparseable body, or an event the confirm
     * path does not act on. The endpoint is permit-listed (Revolut is not an authenticated user), so this
     * signature check is the sole authenticity guard — an empty result must be treated as "reject / ignore".
     *
     * @param rawBody          the EXACT raw request bytes — the signature is computed over the unmodified
     *                         body, so it must not be re-serialised or trimmed before verification
     * @param signatureHeader  the {@code Revolut-Signature} header value ({@code v1=…}); may be {@code null}
     * @param timestampHeader  the {@code Revolut-Request-Timestamp} header value; may be {@code null}
     * @return the verified event, or empty when it cannot be trusted / is not actionable
     */
    Optional<PaymentWebhookEvent> parseWebhookEvent(byte[] rawBody, String signatureHeader, String timestampHeader);
}
