package com.teammarhaba.backend.membership;

/**
 * The outcome of the entitlement resolver (TM-476): whether — and at what cost — the caller may
 * attend an event, given their {@link MembershipTier} + first-event credit and the event's
 * price/premium. It is the {@code decision} field of {@code GET /api/v1/events/{id}/entitlement}, the
 * authoritative source the checkout screen (TM-479) consumes in place of its client-side rule, so the
 * price the user sees and what RSVP will charge always agree.
 *
 * <ul>
 *   <li>{@link #FREE} — no charge because the caller's first-event credit covers this
 *       <em>standard</em> event, or the event itself is genuinely free (£0). Consumed on commitment by
 *       checkout (TM-477); the resolver only reads the credit, it never spends it.</li>
 *   <li>{@link #INCLUDED} — no charge because the caller's tier already covers it: {@code MONTHLY} on a
 *       standard event, {@code DIAMOND} on any event.</li>
 *   <li>{@link #PAY} — the caller must pay {@code amountPence}: pay-per-event on a standard event
 *       (£5 / the standard price), or any tier below Diamond on a premium event (the premium price).</li>
 *   <li>{@link #UPGRADE} — the caller's tier is too low to attend and must be upgraded first (no direct
 *       charge for this event). <strong>Reserved contract value:</strong> the original AC gated
 *       {@code MONTHLY} on a premium event this way, but the 2026-07-10 product decision (see the
 *       TM-476 Wave-1 build note) changed that to {@link #PAY} the premium price, so no current rule
 *       produces {@code UPGRADE}. It stays in the contract for the checkout screen's existing enum and
 *       any future hard gate.</li>
 * </ul>
 *
 * <p>Serialised by {@code name()} (Jackson default), so values may be <em>added</em> but existing names
 * must not be renamed — clients switch on the string.
 */
public enum EntitlementDecision {

    /** No charge — a first-event credit covers this standard event, or the event is genuinely free. */
    FREE,

    /** No charge — the caller's membership tier already covers this event. */
    INCLUDED,

    /** The caller must pay {@code amountPence} (the standard or premium price). */
    PAY,

    /** Reserved: the caller's tier is too low; upgrade required. No current rule produces this. */
    UPGRADE
}
