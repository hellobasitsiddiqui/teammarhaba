package com.teammarhaba.backend.auth;

/**
 * Thrown by a real {@link EmailCodeMailer} transport (TM-249) when delivery of a login code fails,
 * so {@link EmailCodeService#request(String)} surfaces the failure to the caller instead of pretending
 * a code was sent. Unchecked to keep the {@link EmailCodeMailer#sendLoginCode(String, String)} seam
 * signature unchanged (the logging/emulator implementations never fail). Carries no code — the cause
 * is the underlying mail exception, and the message is deliberately generic.
 */
public class EmailCodeDeliveryException extends RuntimeException {

    public EmailCodeDeliveryException(String message, Throwable cause) {
        super(message, cause);
    }
}
