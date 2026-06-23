package com.teammarhaba.backend.auth;

/**
 * Signals that an email-verification resend could not be honoured for a reason the caller can act
 * on (TM-165). Carries a {@link Reason} the web layer maps to a specific RFC 7807 status, so the
 * controller stays free of HTTP concerns and {@code GlobalExceptionHandler} owns the contract.
 *
 * <ul>
 *   <li>{@link Reason#ALREADY_VERIFIED} — the address is already verified (Firebase is the source of
 *       truth); resending is pointless. Mapped to {@code 422 Unprocessable Entity}.</li>
 *   <li>{@link Reason#COOLDOWN} — a resend was triggered too recently; the per-user cooldown is still
 *       active. Mapped to {@code 429 Too Many Requests}.</li>
 * </ul>
 */
public class EmailVerificationException extends RuntimeException {

    /** Why the resend was refused — drives the HTTP status in the web layer. */
    public enum Reason {
        ALREADY_VERIFIED,
        COOLDOWN
    }

    private final Reason reason;

    public EmailVerificationException(Reason reason, String message) {
        super(message);
        this.reason = reason;
    }

    public Reason reason() {
        return reason;
    }
}
