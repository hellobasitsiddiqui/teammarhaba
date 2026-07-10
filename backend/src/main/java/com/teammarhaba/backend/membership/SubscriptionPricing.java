package com.teammarhaba.backend.membership;

/**
 * The locked monthly prices for the paid membership tiers (TM-620, product decision 2026-07-10):
 * MONTHLY = £9.99/mo, DIAMOND = £19.99/mo (all-access including premium events, no surcharge). One
 * static table so the checkout, the renewal engine and the API response can never disagree on a price.
 * In pence (minor units, GBP) — the house money convention (mirrors {@code Order.amountPence}); the
 * client mirror lives in {@code web/src/assets/membership-subscribe-core.js}.
 */
public final class SubscriptionPricing {

    /** MONTHLY tier: £9.99 per month. */
    public static final int MONTHLY_PENCE = 999;

    /** DIAMOND tier: £19.99 per month (all-access incl. premium). */
    public static final int DIAMOND_PENCE = 1999;

    private SubscriptionPricing() {
        // Static price table — never instantiated.
    }

    /** Whether {@code tier} is a paid, subscribable tier (everything except the free base). */
    public static boolean isPaidTier(MembershipTier tier) {
        return tier == MembershipTier.MONTHLY || tier == MembershipTier.DIAMOND;
    }

    /**
     * The monthly price of a paid tier in pence.
     *
     * @throws IllegalArgumentException for the free base tier — it has no subscription price, and a
     *                                  caller asking for one is a programming error the tests catch
     */
    public static int monthlyPricePence(MembershipTier tier) {
        return switch (tier) {
            case MONTHLY -> MONTHLY_PENCE;
            case DIAMOND -> DIAMOND_PENCE;
            case PAY_PER_EVENT -> throw new IllegalArgumentException("PAY_PER_EVENT has no subscription price");
        };
    }
}
