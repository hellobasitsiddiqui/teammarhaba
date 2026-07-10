package com.teammarhaba.backend.api;

import com.teammarhaba.backend.membership.MembershipTier;
import com.teammarhaba.backend.membership.SubscriptionCheckout;

/**
 * Response of {@code POST /api/v1/me/subscription/checkout} (TM-620): what the browser needs to take
 * the first subscription payment. The client mounts the Revolut card widget with {@code paymentToken}
 * and {@code savePaymentMethodFor: "merchant"} (so the card is saved for off-session renewals); the
 * subscription itself activates server-side when the settle webhook lands — never from the client.
 *
 * @param tier         the paid tier being bought
 * @param amountPence  the first (and recurring monthly) charge in pence — display-only; the server
 *                     already priced the provider order
 * @param paymentToken the provider's single-use client token that mounts the checkout widget
 * @param provider     the payment gateway ({@code "revolut"}) so the client mounts the right widget
 */
public record SubscriptionCheckoutResponse(
        MembershipTier tier, int amountPence, String paymentToken, String provider) {

    static SubscriptionCheckoutResponse from(SubscriptionCheckout checkout) {
        return new SubscriptionCheckoutResponse(
                checkout.tier(), checkout.amountPence(), checkout.paymentToken(), checkout.provider());
    }
}
