package com.teammarhaba.backend.membership;

/**
 * Thrown when a direct join verb — {@code POST /events/{id}/rsvp} or {@code POST /events/{id}/claim}
 * (TM-625) — is refused because the caller's entitlement to the event resolves to
 * {@link EntitlementDecision#PAY} and no settled (CONFIRMED) order backs the join. The join must go
 * through checkout ({@code POST /events/{id}/checkout}, TM-477/478) so the money settles first; the
 * paid RSVP then lands via the payment webhook, never via the free verbs.
 *
 * <p>This closes the residual deploy blocker from the TM-623 adversarial re-verify: the checkout PAY
 * branch was gated (403 while the membership flag is off, a real provider order otherwise), but the
 * plain RSVP/claim verbs still let any authenticated caller land {@code GOING} on a priced/premium
 * event with no order and no payment — a free-join bypass of the entire paid path.
 *
 * <p>Mapped to a {@code 402 Payment Required} RFC 7807 response by {@code GlobalExceptionHandler} —
 * the honest status for "this needs a payment first" — with the user-facing {@code detail} pointing
 * the caller at checkout. Only raised while {@code app.membership.enabled} is true: with the flag off
 * the paid feature does not exist, so the verbs keep their legacy ungated behaviour.
 */
public class PaymentRequiredException extends RuntimeException {

    public PaymentRequiredException(String message) {
        super(message);
    }
}
