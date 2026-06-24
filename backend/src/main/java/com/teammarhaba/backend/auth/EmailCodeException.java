package com.teammarhaba.backend.auth;

/**
 * Signals that a passwordless email-code login step (request or verify) could not be honoured for a
 * reason the caller can act on (TM-234). Carries a {@link Reason} the web layer maps to a specific
 * RFC 7807 status, so the controller stays free of HTTP concerns and {@code GlobalExceptionHandler}
 * owns the contract — mirroring {@link EmailVerificationException} (TM-165).
 *
 * <ul>
 *   <li>{@link Reason#SEND_RATE_LIMITED} — a code was requested for this address too recently (the
 *       per-address send cooldown is still active). Mapped to {@code 429 Too Many Requests}.</li>
 *   <li>{@link Reason#CODE_INVALID} — the submitted code does not match the outstanding one (or none
 *       is outstanding). Mapped to {@code 401 Unauthorized}: it's an authentication failure.</li>
 *   <li>{@link Reason#CODE_EXPIRED} — a code was issued but its short TTL has elapsed. Mapped to
 *       {@code 410 Gone}: the credential existed but is no longer valid; request a fresh one.</li>
 *   <li>{@link Reason#VERIFY_RATE_LIMITED} — too many wrong attempts against the outstanding code;
 *       it is burned to stop brute-forcing. Mapped to {@code 429 Too Many Requests}.</li>
 * </ul>
 *
 * <p>The messages are deliberately generic (they never reveal whether an address has an account or
 * how many attempts remain) so the endpoint cannot be used to enumerate users or probe the code.
 */
public class EmailCodeException extends RuntimeException {

    /** Why the request/verify was refused — drives the HTTP status in the web layer. */
    public enum Reason {
        SEND_RATE_LIMITED,
        CODE_INVALID,
        CODE_EXPIRED,
        VERIFY_RATE_LIMITED
    }

    private final Reason reason;

    public EmailCodeException(Reason reason, String message) {
        super(message);
        this.reason = reason;
    }

    public Reason reason() {
        return reason;
    }
}
