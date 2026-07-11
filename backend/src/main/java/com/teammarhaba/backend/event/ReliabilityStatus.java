package com.teammarhaba.backend.event;

/**
 * An account's reliability <em>standing</em> (TM-409), derived from its running late-cancellation
 * strike count ({@code users.late_cancel_count}) against the configured warn/downgrade thresholds
 * ({@code ReliabilityProperties}). This is the "threshold engine" output: a small, honest state the
 * user and the admin console can read, and the un-RSVP/RSVP paths act on.
 *
 * <p>Ordered least-to-most restricted so {@code ordinal()} is monotonic — do not reorder (the values
 * are also serialised by {@code name()} into responses, so names must stay stable).
 */
public enum ReliabilityStatus {

    /** In good standing — below the warning threshold (or the feature is off). No consequence. */
    OK,

    /**
     * On a reliability <em>warning</em> — strikes have reached {@code warnThreshold} but not
     * {@code downgradeThreshold}. A transparent nudge only; no capability is removed yet.
     */
    WARNED,

    /**
     * <em>Downgraded</em> — strikes have reached {@code downgradeThreshold}. The account can no longer
     * take a GOING spot on a capacity-limited event (it is restricted to the waitlist); enforced at
     * RSVP/claim time with an honest {@code 409}.
     */
    DOWNGRADED
}
