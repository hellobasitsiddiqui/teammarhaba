package com.teammarhaba.backend.notify;

/**
 * Signals that an admin broadcast was refused because the same admin sent one too recently — the
 * per-admin-uid send cooldown is still active (TM-364, epic TM-358). This is the accidental-double-send
 * guard: a fat-fingered resubmit (or a retrying client) inside the window is rejected rather than
 * blasting every recipient twice.
 *
 * <p>Mapped to {@code 429 Too Many Requests} by {@code GlobalExceptionHandler}, mirroring the
 * email-verification / email-code cooldowns (TM-165 / TM-247), so the client backs off. Carrying the
 * refusal as a typed exception keeps {@link BroadcastService} free of HTTP concerns — the web layer
 * owns the status contract.
 *
 * <p>Like those precedents the cooldown is <strong>process-local</strong> (a {@code ConcurrentHashMap}
 * on a single Cloud Run instance); a shared store (Redis) for a cluster-wide guard is the noted future
 * improvement, consistent with TM-247.
 */
public class BroadcastCooldownException extends RuntimeException {

    public BroadcastCooldownException(String message) {
        super(message);
    }
}
