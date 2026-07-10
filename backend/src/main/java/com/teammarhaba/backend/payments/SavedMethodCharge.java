package com.teammarhaba.backend.payments;

import java.util.Locale;
import java.util.Set;

/**
 * The synchronous outcome of charging a saved payment method off-session (TM-620) — the reduced,
 * provider-neutral answer the renewal engine acts on, so Revolut's payment-state zoo never leaks past
 * the {@link PaymentProvider} seam (the same reduction {@link PaymentWebhookEvent} performs for
 * webhooks).
 *
 * <p>A merchant-initiated transaction (MIT) needs no SCA challenge — the mandate was authenticated on
 * the first, in-browser payment — so the pay-order call settles synchronously and its response state is
 * authoritative enough to extend a subscription on. The asynchronous webhook remains the idempotent
 * backstop (see {@code SubscriptionService#confirmCharge}).
 *
 * @param state   the provider's raw payment/order state (e.g. {@code completed}, {@code declined}) —
 *                persisted nowhere, but logged for dunning diagnostics
 * @param settled {@code true} when the money is taken and the period may be extended; {@code false}
 *                for a decline/failure (the dunning path)
 */
public record SavedMethodCharge(String state, boolean settled) {

    /**
     * Provider states that mean the charge succeeded. {@code completed}/{@code captured} are the
     * terminal paid states of an auto-capture order; {@code authorised} covers an auth-then-capture
     * setup (mirroring {@code RevolutPaymentProvider}'s settled webhook events). Anything else —
     * {@code declined}, {@code failed}, {@code soft_declined}, … — is a dunning-path failure.
     */
    private static final Set<String> SETTLED_STATES = Set.of("completed", "captured", "authorised");

    /** Reduce a raw provider state string to a {@link SavedMethodCharge}. Null-safe (null = not settled). */
    public static SavedMethodCharge fromState(String state) {
        String normalised = state == null ? "" : state.trim().toLowerCase(Locale.ROOT);
        return new SavedMethodCharge(normalised, SETTLED_STATES.contains(normalised));
    }
}
