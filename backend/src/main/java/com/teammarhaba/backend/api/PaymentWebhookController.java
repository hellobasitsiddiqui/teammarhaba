package com.teammarhaba.backend.api;

import com.teammarhaba.backend.payments.PaymentWebhookService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * Inbound payment webhook (TM-478), under {@code /api/v1/payments} (the {@code /api/v1} prefix is applied
 * by {@link ApiV1Config}). Revolut calls {@code POST /payments/revolut/webhook} when an order's state
 * changes; on a settled event we confirm the local order and perform the held-back RSVP.
 *
 * <p><b>Unauthenticated by design, but signature-verified.</b> The caller is Revolut, not a signed-in
 * user, so this route is allow-listed in {@code SecurityConfig} (no Firebase token). Authenticity is
 * enforced instead by the {@code Revolut-Signature} HMAC — {@link PaymentWebhookService} verifies it
 * before anything is confirmed. A payload that does not verify gets a {@code 401} and changes nothing.
 *
 * <p><b>Raw body.</b> The signature is computed over the exact request bytes, so the body is taken as
 * {@code byte[]} (never a parsed DTO) and passed through unmodified; re-serialising it would break the HMAC.
 *
 * <p><b>Idempotent + retry-friendly.</b> A verified delivery always returns {@code 200} — including a
 * verified non-settle event and a repeat of an already-confirmed order (the confirm is a no-op) — so
 * Revolut does not retry a payload we have already accepted.
 */
@RestController
public class PaymentWebhookController {

    private final PaymentWebhookService webhooks;

    PaymentWebhookController(PaymentWebhookService webhooks) {
        this.webhooks = webhooks;
    }

    /**
     * Receive a Revolut order webhook. Returns {@code 200} when the signature verifies (whether or not the
     * event was a settle we acted on), {@code 401} when it cannot be trusted.
     *
     * @param body      the raw request bytes (the signed payload)
     * @param signature the {@code Revolut-Signature} header ({@code v1=…}); optional so a missing header is
     *                  handled as an unverifiable request (401) rather than a 400 "required header" error
     * @param timestamp the {@code Revolut-Request-Timestamp} header; optional for the same reason
     */
    @PostMapping("/payments/revolut/webhook")
    public ResponseEntity<Void> revolutWebhook(
            @RequestBody(required = false) byte[] body,
            @RequestHeader(value = "Revolut-Signature", required = false) String signature,
            @RequestHeader(value = "Revolut-Request-Timestamp", required = false) String timestamp) {
        boolean verified = webhooks.handle(body == null ? new byte[0] : body, signature, timestamp);
        return verified ? ResponseEntity.ok().build() : ResponseEntity.status(401).build();
    }
}
