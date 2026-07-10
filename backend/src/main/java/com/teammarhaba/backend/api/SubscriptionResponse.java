package com.teammarhaba.backend.api;

import com.teammarhaba.backend.membership.MembershipTier;
import com.teammarhaba.backend.membership.Subscription;
import com.teammarhaba.backend.membership.SubscriptionPricing;
import com.teammarhaba.backend.membership.SubscriptionStatus;
import java.time.Instant;

/**
 * The caller's subscription state (TM-620), returned by {@code GET /api/v1/me/subscription} and
 * {@code POST /api/v1/me/subscription/cancel}. Always a {@code 200}: a caller who never subscribed gets
 * the well-defined none-state ({@code subscribed=false}, everything else {@code null}) rather than a
 * 404, so the manage-subscription screen renders off one shape.
 *
 * @param subscribed         whether a subscription row exists at all (in any status)
 * @param tier               the paid tier the subscription is for; {@code null} when none
 * @param status             {@code ACTIVE | PAST_DUE | CANCELED}; {@code null} when none
 * @param currentPeriodStart start of the currently paid-for window
 * @param currentPeriodEnd   end of the paid-for window — the renewal date while renewing, the access
 *                           horizon after a cancel
 * @param renewing           {@code true} while renewals still run (ACTIVE/PAST_DUE) — the client shows
 *                           "Renews on …" vs "Ends on …" off this
 * @param amountPence        the recurring monthly charge in pence; {@code null} when none
 */
public record SubscriptionResponse(
        boolean subscribed,
        MembershipTier tier,
        SubscriptionStatus status,
        Instant currentPeriodStart,
        Instant currentPeriodEnd,
        Boolean renewing,
        Integer amountPence) {

    /** The none-state for a caller who has never subscribed. */
    static SubscriptionResponse none() {
        return new SubscriptionResponse(false, null, null, null, null, null, null);
    }

    static SubscriptionResponse from(Subscription subscription) {
        return new SubscriptionResponse(
                true,
                subscription.getTier(),
                subscription.getStatus(),
                subscription.getCurrentPeriodStart(),
                subscription.getCurrentPeriodEnd(),
                subscription.isRenewing(),
                SubscriptionPricing.monthlyPricePence(subscription.getTier()));
    }
}
