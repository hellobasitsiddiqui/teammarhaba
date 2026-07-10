package com.teammarhaba.backend.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * The SERVER-SIDE membership kill switch (TM-623), bound from {@code app.membership.*} and picked up
 * by the app-wide {@code @ConfigurationPropertiesScan}. The {@code membership} flag in
 * {@code web/src/assets/config.js} only hides the UI — it cannot make server endpoints unreachable
 * (any authenticated caller can still curl them). This flag is the backend's own authority over every
 * money-moving path:
 *
 * <ul>
 *   <li>{@code SubscriptionService.checkout}/{@code cancel} — 404 when off (the feature does not
 *       exist).</li>
 *   <li>{@code MembershipService.switchTier} into a paid tier — 403 when off.</li>
 *   <li>{@code CheckoutService.checkout}'s PAY branch — 403 when off (no provider order is ever
 *       opened).</li>
 *   <li>{@code SubscriptionRenewalScheduler} — the bean is not even created when off, so no
 *       off-session charge can fire (see its {@code @ConditionalOnProperty}).</li>
 * </ul>
 *
 * <p><strong>Default OFF.</strong> A boot with no configuration must be money-inert: the deploy sets
 * {@code MEMBERSHIP_ENABLED} explicitly (see {@code deploy.yml}), and launch flips it together with
 * the web flag. Read-only surfaces (subscription state, entitlement resolution, membership reads)
 * stay available regardless — only paths that can move money are gated.
 *
 * @param enabled whether the paid membership feature (subscriptions + per-event payments) is live;
 *                {@code null}/missing means OFF (fail-safe)
 */
@ConfigurationProperties(prefix = "app.membership")
public record MembershipProperties(Boolean enabled) {

    public MembershipProperties {
        enabled = enabled != null && enabled; // missing/blank ⇒ OFF: the money paths must opt IN
    }
}
