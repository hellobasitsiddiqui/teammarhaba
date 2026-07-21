package com.teammarhaba.backend.auth;

/**
 * The caller's Firebase-verified phone could not be established when verified-phone enforcement is on
 * (TM-931): either Firebase reported no verified phone, or the read itself failed (no Admin SDK bean,
 * user absent, SDK error) and the service fails closed. Both cases are a refusal of the onboarding
 * transition. {@code UserService} translates this into the distinct, stable {@code 400} the gate UI
 * (TM-930) keys on — "Phone number must be verified before completing onboarding".
 */
public class VerifiedPhoneUnavailableException extends RuntimeException {

    public VerifiedPhoneUnavailableException(String message) {
        super(message);
    }

    public VerifiedPhoneUnavailableException(String message, Throwable cause) {
        super(message, cause);
    }
}
