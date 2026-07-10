package com.teammarhaba.backend.payments;

/**
 * Thrown when a payment provider call fails (TM-478) — a non-2xx create-order response, a transport
 * error, or an unparseable body. Unchecked so it propagates out of the {@code @Transactional} checkout
 * and rolls the whole commitment back: if we could not create the Revolut order, no local {@code PENDING}
 * order (and no consumed credit) must be left behind. Surfaces as a generic {@code 500} via the global
 * handler — the underlying provider message is kept server-side and never echoed to the caller.
 */
public class PaymentProviderException extends RuntimeException {

    public PaymentProviderException(String message) {
        super(message);
    }

    public PaymentProviderException(String message, Throwable cause) {
        super(message, cause);
    }
}
