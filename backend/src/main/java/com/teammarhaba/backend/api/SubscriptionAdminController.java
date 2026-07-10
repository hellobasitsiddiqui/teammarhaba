package com.teammarhaba.backend.api;

import com.teammarhaba.backend.membership.SubscriptionService;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/**
 * Admin read of an account's subscription state + billing history under
 * {@code /api/v1/admin/users/{id}/subscription} (TM-620) — the backend for the admin users console's
 * subscription panel. Gated by {@code @PreAuthorize("hasRole('ADMIN')")} exactly like
 * {@link UserAdminController}: a non-admin gets a uniform {@code 403}, an anonymous caller a
 * {@code 401} from the security chain. Read-only — an admin inspects billing state here; changing it
 * goes through the user's own subscribe/cancel flow (or the provider dashboard for money matters).
 *
 * <p>An account that never subscribed returns the well-defined none-state with an empty history (a
 * {@code 200}) — the panel then reads "no subscription" without a special error path.
 */
@RestController
@PreAuthorize("hasRole('ADMIN')")
public class SubscriptionAdminController {

    private final SubscriptionService subscriptions;

    SubscriptionAdminController(SubscriptionService subscriptions) {
        this.subscriptions = subscriptions;
    }

    /** One account's subscription state + charge history, newest first (TM-620). */
    @GetMapping("/admin/users/{id}/subscription")
    AdminSubscriptionResponse subscription(@PathVariable Long id) {
        return AdminSubscriptionResponse.from(subscriptions.adminView(id));
    }
}
