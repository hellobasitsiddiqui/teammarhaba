package com.teammarhaba.backend.web;

/**
 * Thrown for a malformed/invalid request that Bean Validation doesn't cover — e.g. an unknown sort
 * property on a list endpoint (TM-111). Mapped to a {@code 400} RFC 7807 response by
 * {@link GlobalExceptionHandler}. A reusable seam, mirroring {@link ResourceNotFoundException}.
 */
public class BadRequestException extends RuntimeException {

    public BadRequestException(String message) {
        super(message);
    }
}
