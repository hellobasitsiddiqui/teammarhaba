package com.teammarhaba.backend.payments;

import com.teammarhaba.backend.membership.CheckoutService;
import com.teammarhaba.backend.membership.SubscriptionService;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Handles an inbound payment webhook (TM-478): verify → interpret → confirm. The thin bridge between the
 * provider-specific {@link PaymentProvider} (signature check + event parse) and the domain confirm
 * ({@link CheckoutService#confirmPayment}, which moves the local order {@code PENDING → CONFIRMED} and
 * performs the held-back RSVP). Kept out of the controller so the HTTP layer stays a shell and the
 * verification/dispatch is unit-testable on its own.
 *
 * <p>Contract (drives the controller's status codes):
 *
 * <ul>
 *   <li><b>verified + settled</b> — confirm the order/charge (idempotently) and return {@code true}.</li>
 *   <li><b>verified + failed</b> (decline/fail, TM-634) — mark the local order/charge terminal
 *       ({@code FAILED}), never activate anything, and return {@code true}: the signature was valid, so we
 *       acknowledge with a 2xx and the provider stops retrying.</li>
 *   <li><b>verified + other</b> (cancel/expire/…) — a no-op that still returns {@code true}.</li>
 *   <li><b>unverifiable / unparseable</b> — return {@code false} so the controller answers 401; the payload
 *       could not be trusted (bad or absent signature).</li>
 * </ul>
 */
@Service
public class PaymentWebhookService {

    private static final Logger log = LoggerFactory.getLogger(PaymentWebhookService.class);

    private final PaymentProvider provider;
    private final CheckoutService checkout;
    private final SubscriptionService subscriptions;

    public PaymentWebhookService(
            PaymentProvider provider, CheckoutService checkout, SubscriptionService subscriptions) {
        this.provider = provider;
        this.checkout = checkout;
        this.subscriptions = subscriptions;
    }

    /**
     * Process one webhook delivery. Returns {@code true} when the payload verified (whether or not it was a
     * settle event we acted on), {@code false} when the signature could not be verified / the body was
     * unusable — the caller maps {@code false} to a 401.
     *
     * @param rawBody         the exact raw request bytes (the signature is computed over these unmodified)
     * @param signatureHeader the {@code Revolut-Signature} header value (may be {@code null})
     * @param timestampHeader the {@code Revolut-Request-Timestamp} header value (may be {@code null})
     */
    public boolean handle(byte[] rawBody, String signatureHeader, String timestampHeader) {
        Optional<PaymentWebhookEvent> event = provider.parseWebhookEvent(rawBody, signatureHeader, timestampHeader);
        if (event.isEmpty()) {
            return false; // bad/absent signature or unparseable body → controller returns 401
        }

        PaymentWebhookEvent e = event.get();
        switch (e.outcome()) {
            case SETTLED -> {
                // A settled payment is EITHER an event-ticket order or a subscription charge — the provider
                // order id lives in exactly one of the two ledgers, and each confirm ignores ids it does not
                // own, so dispatching to both is safe and keeps this bridge ledger-agnostic. Both are
                // idempotent: a repeat delivery for an already-confirmed order/charge is a no-op.
                boolean orderMatched = checkout.confirmPayment(e.providerOrderId());
                boolean chargeMatched = subscriptions.confirmCharge(e.providerOrderId());
                if (orderMatched || chargeMatched) {
                    log.info("Confirmed provider order {} via webhook", e.providerOrderId());
                } else {
                    // A VERIFIED settle that matched neither ledger (TM-625): real money was captured and
                    // we hold no record of it — the silent-money-loss signature. Still acknowledged (a
                    // retry would match nothing either), but flagged loudly with the order id so the
                    // capture can be reconciled against the provider dashboard instead of vanishing.
                    log.warn(
                            "Settled payment webhook for provider order {} matched NO local ledger — "
                                    + "captured money with no record; reconcile against the provider (TM-625).",
                            e.providerOrderId());
                }
            }
            case FAILED -> {
                // A declined/failed INITIAL widget payment (TM-634). Dispatch to BOTH ledgers exactly like a
                // settle (the id lives in at most one), moving the local order/charge to a terminal FAILED
                // state so it stops sitting PENDING forever — and MUST NOT activate membership/subscription.
                // No money was captured on a decline, so an unmatched id is benign (unlike an unmatched
                // settle) — a repeat delivery for an already-terminal record is an idempotent no-op.
                boolean orderMatched = checkout.failPayment(e.providerOrderId());
                boolean chargeMatched = subscriptions.failCharge(e.providerOrderId());
                if (orderMatched || chargeMatched) {
                    log.info("Marked provider order {} FAILED via webhook (payment declined/failed)", e.providerOrderId());
                } else {
                    log.debug("Failed-payment webhook for provider order {} matched no local ledger", e.providerOrderId());
                }
            }
            case OTHER -> {
                // A verified event we do not act on (cancel/expire/…) — acknowledged (2xx) but not acted on.
                log.debug("Ignoring verified non-settle, non-fail payment webhook event");
            }
        }
        return true;
    }
}
