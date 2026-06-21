package com.teammarhaba.backend.web;

/**
 * Thrown when a requested resource does not exist. Mapped to a {@code 404} RFC 7807
 * response by {@link GlobalExceptionHandler}. A reusable seam for feature code — the
 * walking skeleton has no resources yet.
 */
public class ResourceNotFoundException extends RuntimeException {

    public ResourceNotFoundException(String message) {
        super(message);
    }
}
