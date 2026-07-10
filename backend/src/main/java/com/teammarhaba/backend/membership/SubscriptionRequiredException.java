package com.teammarhaba.backend.membership;

/**
 * Thrown by {@link MembershipService#switchTier} when a caller tries to switch INTO a paid tier
 * (MONTHLY/DIAMOND) without an active subscription covering it (TM-620). The old "no payment gate"
 * shortcut is gone: a paid tier is only ever granted by the Subscribe checkout activating a
 * subscription — never by the free self-switch endpoint.
 *
 * <p>Mapped to a {@code 402 Payment Required} RFC 7807 response by {@code GlobalExceptionHandler} —
 * the honest status for "this needs a payment first" — with the user-facing {@code detail} telling the
 * caller to subscribe.
 */
public class SubscriptionRequiredException extends RuntimeException {

    public SubscriptionRequiredException(String message) {
        super(message);
    }
}
