package com.teammarhaba.backend.membership;

/**
 * The lifecycle state of a recurring {@link Subscription} (TM-620 / epic Membership). Stored by
 * {@code name()} via {@code EnumType.STRING} (same convention as {@code membership.tier}) — values may
 * be added but existing names must not be renamed/removed (persisted rows keep referencing them).
 *
 * <ul>
 *   <li>{@link #ACTIVE} — renewing normally: the current period is paid for and the scheduler will
 *       charge the saved card again at {@code current_period_end}.</li>
 *   <li>{@link #PAST_DUE} — a renewal charge failed and dunning retries are in flight
 *       ({@code retry_count}/{@code next_charge_at}). The paid tier is KEPT while we retry; a retry
 *       success returns the row to {@link #ACTIVE}, exhausting the retries lapses it to
 *       {@link #CANCELED} and downgrades the membership to pay-per-event.</li>
 *   <li>{@link #CANCELED} — renewals stopped, either by the user cancelling or by dunning exhaustion.
 *       A user cancel keeps the paid tier until {@code current_period_end} (the paid-for time is
 *       honoured), after which the scheduler downgrades the membership; a dunning lapse downgrades
 *       immediately (the unpaid period was never bought).</li>
 * </ul>
 */
public enum SubscriptionStatus {

    /** Renewing normally — the next charge is due at the period end. */
    ACTIVE,

    /** A renewal failed; dunning retries are running and the tier is kept while they last. */
    PAST_DUE,

    /** Renewals stopped (user cancel or dunning lapse); the tier survives to the period end at most. */
    CANCELED
}
