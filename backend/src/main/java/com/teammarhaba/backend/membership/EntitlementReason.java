package com.teammarhaba.backend.membership;

/**
 * A stable, machine-readable code explaining <em>why</em> the entitlement resolver reached its
 * {@link EntitlementDecision} (TM-476). It is the {@code reason} field of
 * {@code GET /api/v1/events/{id}/entitlement}: the checkout screen (TM-479) can switch on it to pick
 * the exact copy ("Your first event is on us" vs "Included with your Diamond membership") without
 * re-deriving the rule, and it keeps the decision auditable/greppable.
 *
 * <p>Serialised by {@code name()} (Jackson default) — treat these as a wire contract: add values, never
 * rename. Each reason maps 1:1 onto a branch of {@link EntitlementResolver}.
 */
public enum EntitlementReason {

    /** Pay-per-event caller's first-event credit covers this standard event ({@link EntitlementDecision#FREE}). */
    FIRST_EVENT_FREE,

    /** The event is genuinely free (£0) — free for everyone, consumes no credit ({@link EntitlementDecision#FREE}). */
    FREE_EVENT,

    /** {@code MONTHLY} tier covers this standard event, no charge ({@link EntitlementDecision#INCLUDED}). */
    INCLUDED_MONTHLY,

    /** {@code DIAMOND} tier covers every event incl. premium, no charge ({@link EntitlementDecision#INCLUDED}). */
    INCLUDED_DIAMOND,

    /** Pay-per-event caller with no credit left pays the standard price ({@link EntitlementDecision#PAY}). */
    PAY_STANDARD,

    /**
     * A premium event: any tier below Diamond pays the premium price ({@link EntitlementDecision#PAY}).
     * Premium events are never free — the first-event credit does not apply and is not consumed
     * (product decision 2026-07-10, TM-476 Wave-1 build note).
     */
    PAY_PREMIUM
}
