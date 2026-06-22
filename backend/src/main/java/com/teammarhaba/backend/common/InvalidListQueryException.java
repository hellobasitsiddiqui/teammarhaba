package com.teammarhaba.backend.common;

/**
 * Thrown when a list request asks for something the convention rejects — currently an
 * un-allow-listed {@code sort} property. Mapped to a {@code 400} ProblemDetail by the global
 * error handler. Allow-listing sort properties (rather than passing the raw client string to
 * Spring Data) keeps callers from probing the schema or triggering a {@code PropertyReferenceException}.
 */
public class InvalidListQueryException extends RuntimeException {

    public InvalidListQueryException(String message) {
        super(message);
    }
}
