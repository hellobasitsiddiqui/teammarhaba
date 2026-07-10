package com.teammarhaba.backend.payments;

import com.teammarhaba.backend.membership.CheckoutService;
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
 *   <li><b>verified + settled</b> — confirm the order (idempotently) and return {@code true}.</li>
 *   <li><b>verified + not-a-settle</b> (decline/cancel/other) — a no-op that still returns {@code true}:
 *       the signature was valid, so we acknowledge with a 2xx and Revolut does not retry.</li>
 *   <li><b>unverifiable / unparseable</b> — return {@code false} so the controller answers 401; the payload
 *       could not be trusted (bad or absent signature).</li>
 * </ul>
 */
@Service
public class PaymentWebhookService {

    private static final Logger log = LoggerFactory.getLogger(PaymentWebhookService.class);

    private final PaymentProvider provider;
    private final CheckoutService checkout;

    public PaymentWebhookService(PaymentProvider provider, CheckoutService checkout) {
        this.provider = provider;
        this.checkout = checkout;
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
        if (e.paid()) {
            // Idempotent: a repeat delivery for an already-CONFIRMED (or unknown) order is a no-op.
            checkout.confirmPayment(e.providerOrderId());
            log.info("Confirmed order for provider order id via webhook");
        } else {
            // A verified non-settle event (decline/cancel/etc.) — acknowledged (2xx) but not acted on here.
            log.debug("Ignoring verified non-settle payment webhook event");
        }
        return true;
    }
}
