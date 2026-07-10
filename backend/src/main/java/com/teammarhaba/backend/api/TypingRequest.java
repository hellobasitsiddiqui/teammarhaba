package com.teammarhaba.backend.api;

/**
 * Optional body for {@code POST /api/v1/conversations/{id}/typing} (TM-465) — the client's typing
 * signal. The whole body is optional: the common case (the <b>debounced "I'm typing" heartbeat</b>) is
 * a body-less POST, so {@code typing} defaults to {@code true}. The client sends an explicit
 * {@code {"typing": false}} only to <b>stop early</b> (composer cleared, or the message just sent), so
 * the indicator clears at once instead of waiting out the receiver-side expiry.
 *
 * <p>There is nothing to validate — the signal is ephemeral and carries no user text — so this is a
 * plain flag record with no Bean Validation constraints.
 *
 * @param typing {@code true}/absent = started/continuing to type; {@code false} = explicitly stopped
 */
public record TypingRequest(Boolean typing) {

    /** The typing state, defaulting an absent/null flag to {@code true} (the "I'm typing" heartbeat). */
    public boolean typingOrDefault() {
        return typing == null || typing;
    }
}
