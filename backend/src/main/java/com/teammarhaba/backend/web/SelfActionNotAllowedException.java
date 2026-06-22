package com.teammarhaba.backend.web;

/**
 * Thrown when an admin attempts a self-protected action on their own account — disabling or
 * changing the role of themselves (TM-111). Mapped to a {@code 422 Unprocessable Entity} RFC 7807
 * response by {@link GlobalExceptionHandler}: the request is well-formed but not permitted.
 */
public class SelfActionNotAllowedException extends RuntimeException {

    public SelfActionNotAllowedException(String message) {
        super(message);
    }
}
