package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * Exhaustive branch coverage for the pure {@link EntitlementResolver} (TM-476): every membership tier ×
 * standard/premium combination, plus the free-event and credit-used edges. No Spring — the resolver is a
 * pure function, so these assert the whole tier × event matrix directly and fast.
 *
 * <p>The load-bearing case is {@link #payPerEventPremiumWithCreditPaysAndDoesNotConsumeCredit()}: a
 * pay-per-event member holding an available first-event credit on a PREMIUM event must resolve to
 * {@code PAY} the premium price — premium events are never free (product decision 2026-07-10) and the
 * credit must not be spent on one.
 */
class EntitlementResolverTest {

    private static final int STANDARD_PRICE = 500; // £5, the default standard price
    private static final int PREMIUM_PRICE = 1500; // £15, an admin-set premium price

    // ------------------------------------------------------------------ PAY_PER_EVENT, standard

    @Test
    void payPerEventWithCreditOnStandardIsFree() {
        Entitlement result =
                EntitlementResolver.resolve(MembershipTier.PAY_PER_EVENT, true, false, STANDARD_PRICE);

        assertThat(result.decision()).isEqualTo(EntitlementDecision.FREE);
        assertThat(result.amountPence()).isZero();
        assertThat(result.reason()).isEqualTo(EntitlementReason.FIRST_EVENT_FREE);
    }

    @Test
    void payPerEventWithoutCreditOnStandardPaysStandardPrice() {
        Entitlement result =
                EntitlementResolver.resolve(MembershipTier.PAY_PER_EVENT, false, false, STANDARD_PRICE);

        assertThat(result.decision()).isEqualTo(EntitlementDecision.PAY);
        assertThat(result.amountPence()).isEqualTo(STANDARD_PRICE);
        assertThat(result.reason()).isEqualTo(EntitlementReason.PAY_STANDARD);
    }

    // ------------------------------------------------------------------ PAY_PER_EVENT, premium (never free)

    /**
     * THE critical branch: a pay-per-event member <em>with</em> an available first-event credit on a
     * PREMIUM event must PAY the premium price — the credit does not apply and, because the resolver
     * returns PAY (not FREE), checkout never consumes it. Premium events are never free.
     */
    @Test
    void payPerEventPremiumWithCreditPaysAndDoesNotConsumeCredit() {
        Entitlement result =
                EntitlementResolver.resolve(MembershipTier.PAY_PER_EVENT, true, true, PREMIUM_PRICE);

        assertThat(result.decision())
                .as("premium is never free even with a first-event credit available")
                .isEqualTo(EntitlementDecision.PAY);
        assertThat(result.amountPence()).isEqualTo(PREMIUM_PRICE);
        assertThat(result.reason()).isEqualTo(EntitlementReason.PAY_PREMIUM);
        // A PAY decision means the credit stays unspent: only a FREE commitment consumes it (TM-477).
    }

    @Test
    void payPerEventPremiumWithoutCreditPaysPremiumPrice() {
        Entitlement result =
                EntitlementResolver.resolve(MembershipTier.PAY_PER_EVENT, false, true, PREMIUM_PRICE);

        assertThat(result.decision()).isEqualTo(EntitlementDecision.PAY);
        assertThat(result.amountPence()).isEqualTo(PREMIUM_PRICE);
        assertThat(result.reason()).isEqualTo(EntitlementReason.PAY_PREMIUM);
    }

    // ------------------------------------------------------------------ MONTHLY

    @Test
    void monthlyOnStandardIsIncluded() {
        Entitlement result = EntitlementResolver.resolve(MembershipTier.MONTHLY, false, false, STANDARD_PRICE);

        assertThat(result.decision()).isEqualTo(EntitlementDecision.INCLUDED);
        assertThat(result.amountPence()).isZero();
        assertThat(result.reason()).isEqualTo(EntitlementReason.INCLUDED_MONTHLY);
    }

    /** Monthly on premium PAYs the premium price (default assumption, not UPGRADE — build note 2026-07-10). */
    @Test
    void monthlyOnPremiumPaysPremiumPrice() {
        Entitlement result = EntitlementResolver.resolve(MembershipTier.MONTHLY, false, true, PREMIUM_PRICE);

        assertThat(result.decision()).isEqualTo(EntitlementDecision.PAY);
        assertThat(result.amountPence()).isEqualTo(PREMIUM_PRICE);
        assertThat(result.reason()).isEqualTo(EntitlementReason.PAY_PREMIUM);
    }

    // ------------------------------------------------------------------ DIAMOND (everything included)

    @Test
    void diamondOnStandardIsIncluded() {
        Entitlement result = EntitlementResolver.resolve(MembershipTier.DIAMOND, false, false, STANDARD_PRICE);

        assertThat(result.decision()).isEqualTo(EntitlementDecision.INCLUDED);
        assertThat(result.amountPence()).isZero();
        assertThat(result.reason()).isEqualTo(EntitlementReason.INCLUDED_DIAMOND);
    }

    /** Diamond covers premium too (default assumption, surfaced in the PR). */
    @Test
    void diamondOnPremiumIsIncluded() {
        Entitlement result = EntitlementResolver.resolve(MembershipTier.DIAMOND, false, true, PREMIUM_PRICE);

        assertThat(result.decision()).isEqualTo(EntitlementDecision.INCLUDED);
        assertThat(result.amountPence()).isZero();
        assertThat(result.reason()).isEqualTo(EntitlementReason.INCLUDED_DIAMOND);
    }

    // ------------------------------------------------------------------ free (£0) standard event

    @Test
    void payPerEventOnFreeStandardEventIsFreeAndKeepsCredit() {
        // A genuinely free (£0) event: FREE for a pay-per-event caller WITH a credit, without spending
        // it — the credit isn't burned on an event that costs nothing.
        Entitlement result = EntitlementResolver.resolve(MembershipTier.PAY_PER_EVENT, true, false, 0);

        assertThat(result.decision()).isEqualTo(EntitlementDecision.FREE);
        assertThat(result.amountPence()).isZero();
        assertThat(result.reason()).isEqualTo(EntitlementReason.FREE_EVENT);
    }

    @Test
    void payPerEventWithoutCreditOnFreeStandardEventIsFree() {
        Entitlement result = EntitlementResolver.resolve(MembershipTier.PAY_PER_EVENT, false, false, 0);

        assertThat(result.decision()).isEqualTo(EntitlementDecision.FREE);
        assertThat(result.amountPence()).isZero();
        assertThat(result.reason()).isEqualTo(EntitlementReason.FREE_EVENT);
    }
}
