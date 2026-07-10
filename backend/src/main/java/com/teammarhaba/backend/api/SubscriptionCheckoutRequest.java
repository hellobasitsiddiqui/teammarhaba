package com.teammarhaba.backend.api;

import com.teammarhaba.backend.membership.MembershipTier;
import jakarta.validation.constraints.NotNull;

/**
 * Request body of {@code POST /api/v1/me/subscription/checkout} (TM-620): which paid tier the caller
 * is subscribing to. The price is NEVER taken from the client — the server resolves it from the locked
 * {@code SubscriptionPricing} table, so a tampered request can't buy Diamond at the Monthly price.
 *
 * @param tier the paid tier to subscribe to ({@code MONTHLY}/{@code DIAMOND}; the free base is a 400)
 */
public record SubscriptionCheckoutRequest(@NotNull MembershipTier tier) {}
