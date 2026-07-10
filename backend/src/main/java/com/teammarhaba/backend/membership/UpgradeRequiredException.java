package com.teammarhaba.backend.membership;

/**
 * Thrown by checkout (TM-477) when the caller's entitlement is {@link EntitlementDecision#UPGRADE}: their
 * tier is too low to attend and no per-event charge can unlock it — they must upgrade their membership
 * first. Mapped to a {@code 403 Forbidden} RFC 7807 response by {@code GlobalExceptionHandler} with the
 * user-facing {@code detail}.
 *
 * <p>No current entitlement rule produces {@code UPGRADE} (the 2026-07-10 product decision turned the old
 * Monthly-on-premium gate into a {@code PAY}, see TM-476), but checkout handles it so the reserved
 * contract value has a defined behaviour and a future hard gate needs no new plumbing.
 */
public class UpgradeRequiredException extends RuntimeException {

    public UpgradeRequiredException(String message) {
        super(message);
    }
}
