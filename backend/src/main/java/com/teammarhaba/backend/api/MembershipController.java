package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.membership.MembershipService;
import jakarta.validation.Valid;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * The caller's membership under {@code /api/v1/me/membership} (the {@code /api/v1} prefix is applied by
 * {@link ApiV1Config}). Reaching it requires a valid Firebase {@code Bearer} token; an
 * anonymous/invalid token gets the uniform RFC 7807 {@code 401} from the security chain (default-deny).
 * Identity always comes from the verified {@link VerifiedUser} principal, never the client, so a caller
 * can only read/switch their own membership.
 *
 * <ul>
 *   <li>{@code GET /me/membership} — the caller's membership, <strong>JIT-enrolling</strong> the
 *       account onto {@code PAY_PER_EVENT} on first sight (TM-474; read-only-transaction-safe via the
 *       TM-597 provisioner pattern).</li>
 *   <li>{@code POST /me/membership/tier} — self-switch to another tier. No payment gate in this slice
 *       (paid upgrades come later, TM-478); an actual change is audited
 *       ({@code MEMBERSHIP_TIER_CHANGED}).</li>
 * </ul>
 */
@RestController
public class MembershipController {

    private final MembershipService memberships;

    MembershipController(MembershipService memberships) {
        this.memberships = memberships;
    }

    /**
     * The caller's membership, enrolling it (and the account, if brand new) just-in-time on first read
     * (TM-474). Safe under a read-only request transaction and a first-request burst (TM-597).
     */
    @GetMapping("/me/membership")
    MembershipResponse membership(@AuthenticationPrincipal VerifiedUser caller) {
        return MembershipResponse.from(memberships.getOrEnrol(caller));
    }

    /**
     * Self-switch the caller's membership tier (TM-474). Enrols first if needed. Idempotent — switching
     * to the tier already held returns the unchanged membership without auditing; an actual change bumps
     * the row and records a {@code MEMBERSHIP_TIER_CHANGED} audit event. Returns the resulting membership.
     */
    @PostMapping("/me/membership/tier")
    MembershipResponse switchTier(
            @AuthenticationPrincipal VerifiedUser caller, @RequestBody @Valid MembershipTierRequest request) {
        return MembershipResponse.from(memberships.switchTier(caller, request.tier()));
    }
}
