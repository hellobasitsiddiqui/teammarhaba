package com.teammarhaba.backend.membership;

/**
 * The membership tiers an account can hold (TM-474 / epic Membership). Stored by {@code name()} via
 * Hibernate {@code EnumType.STRING} (same convention as {@code users.role}), so tiers may be
 * <em>added</em> but existing names must not be renamed/removed (persisted rows keep referencing them).
 *
 * <ul>
 *   <li>{@link #PAY_PER_EVENT} — the default every account is JIT-enrolled onto. Pay for each event
 *       you attend; no recurring charge.</li>
 *   <li>{@link #MONTHLY} — a recurring monthly subscription (paid-upgrade billing is TM-478).</li>
 *   <li>{@link #DIAMOND} — the premium recurring tier (paid-upgrade billing is TM-478).</li>
 * </ul>
 *
 * <p>This slice lets a caller self-switch tiers freely (no payment gate); the Revolut payment gate for
 * the paid tiers lands later (TM-478). Ordinal order is not relied on anywhere — always match by name.
 */
public enum MembershipTier {

    /** Pay-per-event: the default tier every account is enrolled onto on first sight. */
    PAY_PER_EVENT,

    /** Recurring monthly subscription (paid-upgrade billing is TM-478). */
    MONTHLY,

    /** Premium recurring tier (paid-upgrade billing is TM-478). */
    DIAMOND
}
