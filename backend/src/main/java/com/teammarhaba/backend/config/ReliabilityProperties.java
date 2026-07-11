package com.teammarhaba.backend.config;

import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.PositiveOrZero;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Config-driven inputs for the reliability-points economy (TM-409), bound from {@code app.reliability.*}.
 * TM-409 is the full reliability layer that <em>wraps</em> the lightweight late-cancellation strike
 * counter TM-414 already increments ({@code users.late_cancel_count}) rather than replacing it: the
 * running strike count is the account's reliability signal, and this config turns that raw count into a
 * <em>standing</em> ({@code OK} → {@code WARNED} → {@code DOWNGRADED}) plus a per-strike "cost" the
 * un-RSVP pre-confirm can be honest about.
 *
 * <p>The model deliberately stays count-backed so it needs <strong>no new table or column</strong>
 * (the ticket's steer): each late cancellation is one strike that debits {@link #penaltyPoints} in the
 * append-only reliability ledger (recorded via the existing audit log, {@code AuditAction.RELIABILITY_PENALTY}),
 * and an account's standing is derived from its strike count against two thresholds:
 *
 * <ol>
 *   <li>{@link #warnThreshold} — strikes at/above this put the account on a reliability <em>warning</em>
 *       ({@code WARNED}); a transparent nudge, no capability is removed.</li>
 *   <li>{@link #downgradeThreshold} — strikes at/above this <em>downgrade</em> the account
 *       ({@code DOWNGRADED}): it can no longer take a GOING spot on a capacity-limited event (it is
 *       restricted to the waitlist), enforced at RSVP/claim time with an honest {@code 409}
 *       ({@code EventRsvpService}).</li>
 * </ol>
 *
 * <p>{@link #enabled} is the master switch: with it <strong>off</strong> no standing is ever derived
 * and the downgrade gate never fires — every account reads {@code OK} and the verbs keep their exact
 * pre-TM-409 behaviour (only the TM-414 strike counter still moves). These are <strong>tunables, not
 * secrets</strong>: dev/test use the shipped defaults; prod may override any of them from the
 * environment.
 *
 * @param enabled            master switch for the reliability standing + downgrade enforcement; a
 *                           {@code null} bind defaults to {@value #DEFAULT_ENABLED}.
 * @param penaltyPoints      reliability points a single late cancellation debits — the "cost" surfaced
 *                           in the pre-confirm copy and recorded as the signed ledger delta; a
 *                           {@code null}/negative bind falls back to {@value #DEFAULT_PENALTY_POINTS}.
 * @param warnThreshold      strike count at/above which an account is {@code WARNED}; a
 *                           {@code null}/non-positive bind falls back to {@value #DEFAULT_WARN_THRESHOLD}.
 * @param downgradeThreshold strike count at/above which an account is {@code DOWNGRADED}; a
 *                           {@code null}/non-positive bind falls back to {@value #DEFAULT_DOWNGRADE_THRESHOLD},
 *                           and a value below {@code warnThreshold} is raised to it (downgrade can never
 *                           come before the warning).
 */
@Validated
@ConfigurationProperties(prefix = "app.reliability")
public record ReliabilityProperties(
        Boolean enabled,
        @PositiveOrZero Integer penaltyPoints,
        @Positive Integer warnThreshold,
        @Positive Integer downgradeThreshold) {

    /** Reliability standing + enforcement ship ON — the whole point of TM-409. */
    public static final boolean DEFAULT_ENABLED = true;

    /** A late cancellation costs this many reliability points by default. */
    public static final int DEFAULT_PENALTY_POINTS = 10;

    /** One late cancellation already puts an account on a reliability warning by default. */
    public static final int DEFAULT_WARN_THRESHOLD = 1;

    /** Three late cancellations downgrade an account (waitlist-only) by default — three strikes. */
    public static final int DEFAULT_DOWNGRADE_THRESHOLD = 3;

    public ReliabilityProperties {
        enabled = (enabled == null) ? DEFAULT_ENABLED : enabled;
        penaltyPoints = (penaltyPoints == null || penaltyPoints < 0) ? DEFAULT_PENALTY_POINTS : penaltyPoints;
        warnThreshold = (warnThreshold == null || warnThreshold <= 0) ? DEFAULT_WARN_THRESHOLD : warnThreshold;
        downgradeThreshold =
                (downgradeThreshold == null || downgradeThreshold <= 0)
                        ? DEFAULT_DOWNGRADE_THRESHOLD
                        : downgradeThreshold;
        // Downgrade can never trigger before the warning: a misconfigured lower value is raised to warn.
        downgradeThreshold = Math.max(downgradeThreshold, warnThreshold);
    }
}
