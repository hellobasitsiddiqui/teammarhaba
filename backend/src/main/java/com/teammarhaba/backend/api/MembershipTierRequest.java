package com.teammarhaba.backend.api;

import com.teammarhaba.backend.membership.MembershipTier;
import jakarta.validation.constraints.NotNull;

/**
 * Body for {@code POST /api/v1/me/membership/tier} (TM-474). The caller states which {@code tier} they
 * want to switch to; identity comes from the verified token, never the client. An unknown/missing tier
 * is a uniform {@code 400} from the enum binding / {@code @NotNull}. No payment gate in this slice —
 * paid upgrades come later (TM-478).
 *
 * @param tier the target tier ({@code PAY_PER_EVENT} | {@code MONTHLY} | {@code DIAMOND}); required
 */
public record MembershipTierRequest(@NotNull MembershipTier tier) {}
