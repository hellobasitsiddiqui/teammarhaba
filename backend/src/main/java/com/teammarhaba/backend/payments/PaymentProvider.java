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
     * Create (or register) a customer with the provider (TM-620) — the container a saved payment method
     * hangs off. Called once, lazily, by the Subscribe checkout: the first charge's provider order is
     * created against this customer so the card the widget saves ({@code savePaymentMethodFor: merchant})
     * is attached to it, and every off-session renewal charges through it.
     *
     * <p>The phone number rides along (TM-623): a phone-only account has no email and no display name,
     * and without ANY identifying field the customer registration is an empty body the provider may well
     * reject — which would lock the whole (supported!) phone-only population out of subscribing.
     *
     * @param email    the account's email (may be {@code null}/blank for a phone-only account — the
     *                 adapter sends what it has)
     * @param phone    the account's phone number in E.164 (may be {@code null}/blank)
     * @param fullName the account's display name (may be {@code null}/blank)
     * @return the provider's permanent customer id (persisted on the subscription,
     *         {@code provider_customer_id})
     * @throws PaymentProviderException if the provider rejects the request or is unreachable
     */
    String createCustomer(String email, String phone, String fullName);

    /**
     * Cancel (void) a provider order that has not been paid (TM-623). Used best-effort whenever the
     * local flow walks away from an order it created — a Subscribe checkout re-pointing its INITIAL
     * charge at a fresh order, or an in-window cancel of a still-PENDING PAY order — so the superseded
     * order's single-use widget token (possibly still mounted in another tab) can no longer capture
     * money that nothing local would reconcile.
     *
     * @param providerOrderId the provider's permanent order id to void
     * @throws PaymentProviderException if the provider is unreachable or refuses the cancel (e.g. the
     *                                  order already completed) — callers treat this as best-effort and
     *                                  log rather than failing the surrounding flow
     */
    void cancelOrder(String providerOrderId);

    /**
     * Refund a captured payment, in full or in part (TM-623) — the execution half of
     * {@code OrderStatus.REFUND_DUE}, which previously had no provider operation behind it at all
     * (captured money could be owed back forever with nothing able to return it).
     *
     * @param providerOrderId the provider's permanent order id whose payment is being returned
     * @param amountMinor     the amount to refund in minor units (pence for GBP)
     * @param currency        the ISO-4217 currency code of the refund (matches the charge)
     * @param reference       an opaque merchant reference for reconciliation (e.g. the local order id)
     * @throws PaymentProviderException if the provider rejects the refund or is unreachable — the
     *                                  order then STAYS {@code REFUND_DUE} so the debt remains visible
     *                                  and retryable
     */
    void refund(String providerOrderId, int amountMinor, String currency, String reference);

    /**
     * Open a payment order for {@code amountMinor} attached to an existing provider customer (TM-620).
     * Identical to {@link #createOrder} except the order carries the customer, which is what lets the
     * checkout widget SAVE the card against that customer (first charge) and what lets a renewal order be
     * paid with that customer's saved method (off-session).
     *
     * @param amountMinor the charge in minor units (pence for GBP)
     * @param currency    the ISO-4217 currency code
     * @param reference   an opaque merchant reference for reconciliation
     * @param customerId  the provider customer id from {@link #createCustomer}
     * @return the created order's permanent id + temporary client token
     * @throws PaymentProviderException if the provider rejects the request or is unreachable
     */
    PaymentOrder createOrderForCustomer(int amountMinor, String currency, String reference, String customerId);

    /**
     * Charge an existing provider order with a saved payment method, off-session (TM-620) — the
     * merchant-initiated transaction (MIT) behind every subscription renewal. No SCA challenge is run:
     * the mandate was authenticated by the customer on the first, in-browser payment, and the provider
     * flags the charge as merchant-initiated ({@code initiator: merchant}) so the issuer applies the MIT
     * exemption.
     *
     * @param providerOrderId the provider order id to pay (from {@link #createOrderForCustomer})
     * @param paymentMethodId the saved payment method id (from {@link #findMerchantSavedPaymentMethod})
     * @return the reduced synchronous outcome — settled, or a decline the dunning path handles
     * @throws PaymentProviderException if the provider is unreachable or rejects the request outright
     *                                  (treated as a failed attempt by the renewal engine)
     */
    SavedMethodCharge payWithSavedMethod(String providerOrderId, String paymentMethodId);

    /**
     * The customer's payment method saved for MERCHANT-initiated use, if any (TM-620). Called after the
     * first checkout settles (to persist the ref on the subscription) and as a renewal-time fallback when
     * no ref is stored. Empty when the customer has no merchant-saved method — the renewal engine treats
     * that as a failed attempt (dunning), never as an error.
     *
     * @param customerId the provider customer id
     * @return the saved payment method id usable off-session, or empty
     * @throws PaymentProviderException if the provider is unreachable
     */
    Optional<String> findMerchantSavedPaymentMethod(String customerId);

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
