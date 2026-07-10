package com.teammarhaba.backend.membership;

/**
 * The pure entitlement rule engine (TM-476): given a caller's tier + first-event credit and an event's
 * price/premium, decide whether they may attend and at what cost. One place owns the tier × event rule
 * so RSVP and the checkout display can never disagree (the AC's "RSVP + display agree").
 *
 * <p><strong>Pure &amp; side-effect-free.</strong> No Spring, no I/O, no clock — every output is a
 * function of the four arguments, so it is exhaustively unit-testable without a container
 * ({@code EntitlementResolverTest} covers every tier × standard/premium branch). The credit is only
 * <em>read</em> here; it is spent (or reversed) on commitment by checkout (TM-477).
 *
 * <p><strong>Rules</strong> (first match wins), per the TM-476 Wave-1 build note:
 *
 * <ol>
 *   <li><b>Diamond</b> → {@code INCLUDED} for every event, premium included (default assumption,
 *       surfaced in the PR).</li>
 *   <li><b>Premium event</b> (any tier below Diamond) → {@code PAY} the premium price. Premium events
 *       are <em>never</em> free (product decision 2026-07-10): the first-event credit does not apply and
 *       is not consumed, and Monthly does not cover premium (default assumption, surfaced in the PR).</li>
 *   <li><b>Monthly</b> on a standard event → {@code INCLUDED} (truly unlimited standard events).</li>
 *   <li><b>Free (£0) standard event</b> → {@code FREE} for everyone, consuming no credit (so a
 *       genuinely-free event never wastes a pay-per-event caller's one credit).</li>
 *   <li><b>Pay-per-event with a first-event credit</b> on a standard event → {@code FREE} (their first
 *       is on us; checkout consumes the credit on commitment).</li>
 *   <li><b>Pay-per-event, no credit</b> on a standard event → {@code PAY} the standard price (£5 / the
 *       admin-set price).</li>
 * </ol>
 *
 * <p>No branch yields {@link EntitlementDecision#UPGRADE}: the original AC gated Monthly-on-premium that
 * way, but the 2026-07-10 decision changed it to {@code PAY} the premium price. {@code UPGRADE} remains a
 * reserved contract value (see {@link EntitlementDecision#UPGRADE}).
 */
public final class EntitlementResolver {

    private EntitlementResolver() {
        // Pure static rule engine — never instantiated.
    }

    /**
     * Resolve the entitlement for a caller against an event (TM-476). See the class Javadoc for the full
     * rule table.
     *
     * @param tier                      the caller's membership tier
     * @param firstEventCreditAvailable whether the caller's first-event freebie is still available (the
     *                                  negation of {@code Membership.firstEventCreditUsed}); only ever
     *                                  matters for a pay-per-event caller on a standard event
     * @param premium                   whether the event is gated as premium ({@code Event.isPremium})
     * @param pricePence                the event's ticket price in pence (minor units, GBP; never
     *                                  negative — {@code 0} = a genuinely free event)
     * @return the decision, the charge in pence, and the reason code
     */
    public static Entitlement resolve(
            MembershipTier tier, boolean firstEventCreditAvailable, boolean premium, int pricePence) {

        // 1. Diamond covers everything, premium included (default assumption; surfaced in the PR).
        if (tier == MembershipTier.DIAMOND) {
            return new Entitlement(EntitlementDecision.INCLUDED, 0, EntitlementReason.INCLUDED_DIAMOND);
        }

        // 2. Premium events are never free (product decision 2026-07-10): every tier below Diamond pays
        // the premium price. The first-event credit does NOT apply and is NOT consumed, and Monthly does
        // not cover premium (default assumption). Checked before the credit/coverage rules so the credit
        // can never leak onto a premium event.
        if (premium) {
            return new Entitlement(EntitlementDecision.PAY, pricePence, EntitlementReason.PAY_PREMIUM);
        }

        // ---- standard (non-premium) events below ----

        // 3. Monthly = truly unlimited standard events, no charge.
        if (tier == MembershipTier.MONTHLY) {
            return new Entitlement(EntitlementDecision.INCLUDED, 0, EntitlementReason.INCLUDED_MONTHLY);
        }

        // ---- pay-per-event on a standard event below ----

        // 4. A genuinely free (£0) event is free for everyone and consumes no credit — so we never burn a
        // pay-per-event caller's one credit on an event that costs nothing anyway.
        if (pricePence == 0) {
            return new Entitlement(EntitlementDecision.FREE, 0, EntitlementReason.FREE_EVENT);
        }

        // 5. First-event credit still available → their first standard event is on us (consumed by
        // checkout on commitment, TM-477 — the resolver only reads the flag).
        if (firstEventCreditAvailable) {
            return new Entitlement(EntitlementDecision.FREE, 0, EntitlementReason.FIRST_EVENT_FREE);
        }

        // 6. Credit already used → pay the standard price (£5 default, or the admin-set price).
        return new Entitlement(EntitlementDecision.PAY, pricePence, EntitlementReason.PAY_STANDARD);
    }
}
