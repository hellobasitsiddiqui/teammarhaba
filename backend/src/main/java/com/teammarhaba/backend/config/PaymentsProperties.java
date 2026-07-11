package com.teammarhaba.backend.config;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Tunables for the payment/checkout layer (TM-634), bound from {@code app.payments.*} and picked up by the
 * app-wide {@code @ConfigurationPropertiesScan}. The provider-specific credentials live under
 * {@code app.payments.revolut.*} (bound separately by {@code RevolutProperties}); this record carries the
 * provider-neutral checkout knobs.
 *
 * <ul>
 *   <li>{@code pendingTtl} — how long a PAY {@link com.teammarhaba.backend.membership.Order} may sit
 *       {@code PENDING} before the TTL sweep expires it. A checkout whose settle/decline webhook never
 *       arrives (the customer closed the tab, the provider never delivered) would otherwise stay
 *       {@code PENDING} forever; the sweep voids its provider order best-effort and moves it to
 *       {@code EXPIRED}. Default 30 minutes — comfortably longer than a real widget payment takes, so a
 *       genuinely in-flight payment is never expired out from under itself.</li>
 * </ul>
 *
 * <p>A tunable, not a secret: a blank/non-positive value falls back to the shipped default so a partial env
 * can never disable the sweep by zeroing the window (the scheduler's own {@code enabled} gate is the
 * off-switch — see {@code app.membership.enabled}).
 *
 * @param pendingTtl how long a PENDING order lives before the sweep expires it (default 30m; non-positive
 *                   falls back)
 */
@ConfigurationProperties(prefix = "app.payments")
public record PaymentsProperties(Duration pendingTtl) {

    private static final Duration DEFAULT_PENDING_TTL = Duration.ofMinutes(30);

    public PaymentsProperties {
        // Missing/blank ⇒ the default; a present-but-non-positive value also falls back rather than
        // expiring every PENDING order instantly (which would race live payments).
        pendingTtl = (pendingTtl == null || pendingTtl.isZero() || pendingTtl.isNegative())
                ? DEFAULT_PENDING_TTL
                : pendingTtl;
    }
}
