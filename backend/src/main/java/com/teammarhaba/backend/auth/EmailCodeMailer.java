package com.teammarhaba.backend.auth;

/**
 * The single seam through which a login code is delivered to a user's inbox (TM-234).
 *
 * <p>This mirrors the email-verification mail path (TM-165): there is <strong>no backend mail
 * transport in the codebase yet</strong>, so the default implementation ({@link LoggingEmailCodeMailer})
 * records that a send was requested without leaking the code, and a future mail-provider ticket
 * swaps in a real transport by providing another bean of this type — without touching
 * {@link EmailCodeService}. Keeping it an interface (rather than inlining the log) makes that
 * future swap a one-bean change and lets tests assert "a code was sent" against a fake.
 */
public interface EmailCodeMailer {

    /**
     * Deliver a freshly-generated login {@code code} to {@code email}.
     *
     * <p>Implementations must treat the code as a credential: never log it, never persist it beyond
     * what delivery requires. A delivery failure should throw so the caller can surface it (the user
     * never learns a code was issued they can't receive).
     *
     * @param email the recipient address (already normalised by the caller)
     * @param code the one-time numeric code to send
     */
    void sendLoginCode(String email, String code);
}
