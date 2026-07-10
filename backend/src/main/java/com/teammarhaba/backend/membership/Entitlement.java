package com.teammarhaba.backend.membership;

/**
 * The resolved entitlement for one (caller, event) pair (TM-476) — the body of
 * {@code GET /api/v1/events/{id}/entitlement} and the return of {@link EntitlementResolver#resolve}.
 * Returned directly as the JSON response ({@code { decision, amountPence, reason }}), the authoritative
 * source the checkout screen (TM-479) consumes so display and RSVP agree.
 *
 * @param decision    whether — and how — the caller may attend ({@code FREE|INCLUDED|PAY|UPGRADE})
 * @param amountPence the charge in pence (minor units, GBP) the caller must pay: the event's price for
 *                    {@link EntitlementDecision#PAY}, and {@code 0} for {@code FREE}/{@code INCLUDED}
 *                    (no charge). Never negative — it mirrors the event's non-negative {@code pricePence}
 * @param reason      the stable machine code explaining the decision (see {@link EntitlementReason})
 */
public record Entitlement(EntitlementDecision decision, int amountPence, EntitlementReason reason) {}
