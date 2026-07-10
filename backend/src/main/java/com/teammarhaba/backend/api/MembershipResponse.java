package com.teammarhaba.backend.api;

import com.teammarhaba.backend.membership.Membership;
import com.teammarhaba.backend.membership.MembershipTier;

/**
 * The caller's membership, returned by {@code GET /api/v1/me/membership} and
 * {@code POST /api/v1/me/membership/tier} (TM-474). The account is JIT-enrolled onto
 * {@link MembershipTier#PAY_PER_EVENT} on first read, so this is always present for an authenticated
 * caller.
 *
 * @param tier                      the account's current membership tier
 * @param firstEventCreditAvailable whether the account's first-event freebie is still available —
 *                                  the negation of the stored {@code firstEventCreditUsed} flag. The
 *                                  consume/reverse logic that spends it lives in checkout (TM-477); a
 *                                  freshly enrolled account has it {@code true}.
 */
public record MembershipResponse(MembershipTier tier, boolean firstEventCreditAvailable) {

    static MembershipResponse from(Membership membership) {
        return new MembershipResponse(membership.getTier(), !membership.isFirstEventCreditUsed());
    }
}
