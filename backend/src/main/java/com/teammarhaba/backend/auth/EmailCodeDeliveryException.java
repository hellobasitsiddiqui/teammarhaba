package com.teammarhaba.backend.auth;

/**
 * Thrown when a real {@link EmailCodeMailer} transport (e.g. {@link SendGridEmailCodeMailer}) fails
 * to deliver a login code (TM-249). The {@link EmailCodeMailer} contract requires a delivery failure
 * to throw, so the caller never tells a user a code was sent that they cannot receive.
 *
 * <p>Messages here name the recipient and a status/cause but <strong>never the code</strong> — the
 * code is a credential.
 */
public class EmailCodeDeliveryException extends RuntimeException {

    public EmailCodeDeliveryException(String message) {
        super(message);
    }

    public EmailCodeDeliveryException(String message, Throwable cause) {
        super(message, cause);
    }
}
