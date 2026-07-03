package com.teammarhaba.backend.web;

/**
 * Thrown when a well-formed request loses to the resource's current state — e.g. an RSVP change
 * after the event has started, or a waitlist claim on a spot that has already been taken
 * (TM-393). Mapped to a {@code 409} RFC 7807 response by {@link GlobalExceptionHandler}; the
 * message is user-facing, so give it honest copy. A reusable seam, mirroring
 * {@link ResourceNotFoundException}.
 */
public class ConflictException extends RuntimeException {

    public ConflictException(String message) {
        super(message);
    }
}
