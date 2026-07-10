package com.teammarhaba.backend.membership;

/**
 * The outcome of opening a Subscribe checkout (TM-620): everything the browser needs to take the first
 * payment and save the card for renewals. The provider's temporary {@code paymentToken} mounts the
 * Revolut widget (with {@code savePaymentMethodFor: "merchant"} so the card is saved for off-session
 * use); the settle webhook then activates the subscription server-side.
 *
 * @param tier         the paid tier being bought ({@code MONTHLY}/{@code DIAMOND})
 * @param amountPence  the first (and recurring monthly) charge in pence (999 / 1999)
 * @param paymentToken the provider's single-use client token — mounts the widget, never persisted
 * @param provider     the payment gateway name ({@code "revolut"}), so the client mounts the right widget
 */
public record SubscriptionCheckout(MembershipTier tier, int amountPence, String paymentToken, String provider) {}
