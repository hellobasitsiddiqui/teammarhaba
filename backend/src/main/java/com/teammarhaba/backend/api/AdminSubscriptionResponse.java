package com.teammarhaba.backend.api;

import com.teammarhaba.backend.membership.MembershipTier;
import com.teammarhaba.backend.membership.SubscriptionCharge;
import com.teammarhaba.backend.membership.SubscriptionService;
import java.time.Instant;
import java.util.List;

/**
 * The admin view of one account's subscription (TM-620), returned by
 * {@code GET /api/v1/admin/users/{id}/subscription}: the current subscription state (the same shape the
 * member sees) plus the billing history — every charge attempt, newest first, with its provider
 * reference so a support question can be reconciled against the Revolut dashboard.
 *
 * @param subscription the account's current subscription state ({@code subscribed=false} none-state
 *                     when they never subscribed)
 * @param charges      the charge-attempt ledger, newest first (capped at the last 50)
 */
public record AdminSubscriptionResponse(SubscriptionResponse subscription, List<ChargeResponse> charges) {

    static AdminSubscriptionResponse from(SubscriptionService.AdminView view) {
        SubscriptionResponse subscription = view.subscription() == null
                ? SubscriptionResponse.none()
                : SubscriptionResponse.from(view.subscription());
        List<ChargeResponse> charges =
                view.charges().stream().map(ChargeResponse::from).toList();
        return new AdminSubscriptionResponse(subscription, charges);
    }

    /**
     * One charge attempt in the admin billing history.
     *
     * @param id              the ledger row id
     * @param kind            {@code INITIAL} (the Subscribe checkout) or {@code RENEWAL} (off-session)
     * @param status          {@code PENDING | PAID | FAILED}
     * @param tier            the tier the charge bought a month of
     * @param amountPence     the charge in pence at charge time
     * @param provider        the payment gateway; {@code null} if the attempt never reached one
     * @param providerOrderId the gateway's order id (the Revolut dashboard handle); may be {@code null}
     * @param periodStart     start of the window the charge (would have) bought; may be {@code null}
     * @param periodEnd       end of that window; may be {@code null}
     * @param createdAt       when the attempt was made
     */
    record ChargeResponse(
            Long id,
            SubscriptionCharge.Kind kind,
            SubscriptionCharge.Status status,
            MembershipTier tier,
            int amountPence,
            String provider,
            String providerOrderId,
            Instant periodStart,
            Instant periodEnd,
            Instant createdAt) {

        static ChargeResponse from(SubscriptionCharge charge) {
            return new ChargeResponse(
                    charge.getId(),
                    charge.getKind(),
                    charge.getStatus(),
                    charge.getTier(),
                    charge.getAmountPence(),
                    charge.getProvider(),
                    charge.getProviderOrderId(),
                    charge.getPeriodStart(),
                    charge.getPeriodEnd(),
                    charge.getCreatedAt());
        }
    }
}
