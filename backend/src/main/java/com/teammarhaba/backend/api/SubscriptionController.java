package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.membership.SubscriptionService;
import jakarta.validation.Valid;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * The caller's recurring subscription under {@code /api/v1/me/subscription} (TM-620; the
 * {@code /api/v1} prefix is applied by {@link ApiV1Config}). Reaching it requires a valid Firebase
 * {@code Bearer} token; identity always comes from the verified {@link VerifiedUser} principal, never
 * the client, so a caller can only ever read/subscribe/cancel their own subscription. The whole flow
 * ships behind the OFF {@code membership} web flag — these endpoints exist but nothing calls them until
 * the flag flips.
 *
 * <ul>
 *   <li>{@code GET /me/subscription} — the caller's subscription state; the {@code subscribed=false}
 *       none-state when they never subscribed (a well-defined 200, never a 404).</li>
 *   <li>{@code POST /me/subscription/checkout} — open the Subscribe checkout for a paid tier: the
 *       first charge + card-save (SCA in the widget); the settle webhook activates the subscription
 *       server-side. 409 when already actively subscribed; 400 for the free base tier.</li>
 *   <li>{@code POST /me/subscription/cancel} — stop renewals; the paid tier survives to the period
 *       end, then the renewal scheduler downgrades to pay-per-event. Idempotent; 404 when there is no
 *       subscription to cancel.</li>
 * </ul>
 */
@RestController
public class SubscriptionController {

    private final SubscriptionService subscriptions;

    SubscriptionController(SubscriptionService subscriptions) {
        this.subscriptions = subscriptions;
    }

    /** The caller's subscription state (TM-620); the none-state when they never subscribed. */
    @GetMapping("/me/subscription")
    SubscriptionResponse subscription(@AuthenticationPrincipal VerifiedUser caller) {
        return subscriptions
                .find(caller)
                .map(SubscriptionResponse::from)
                .orElseGet(SubscriptionResponse::none);
    }

    /**
     * Open the Subscribe checkout (TM-620): first charge + card save via the provider widget. Returns
     * the single-use payment token the browser mounts the widget with; the subscription itself is only
     * ever activated by the verified settle webhook, never by the client claiming success.
     */
    @PostMapping("/me/subscription/checkout")
    SubscriptionCheckoutResponse checkout(
            @AuthenticationPrincipal VerifiedUser caller, @RequestBody @Valid SubscriptionCheckoutRequest request) {
        return SubscriptionCheckoutResponse.from(subscriptions.checkout(caller, request.tier()));
    }

    /** Cancel (TM-620): stop renewals, keep the tier to the period end, then downgrade. Idempotent. */
    @PostMapping("/me/subscription/cancel")
    SubscriptionResponse cancel(@AuthenticationPrincipal VerifiedUser caller) {
        return SubscriptionResponse.from(subscriptions.cancel(caller));
    }
}
