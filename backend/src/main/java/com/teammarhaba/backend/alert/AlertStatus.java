package com.teammarhaba.backend.alert;

import java.time.Instant;

/**
 * The <b>derived</b> lifecycle status of an {@link Alert} (TM-243). It is <em>never stored</em> — it
 * is computed from {@code startsAt}/{@code expiresAt} against the <b>server</b> clock, so a client can
 * never talk a scheduled or expired notice into showing (the AC: "no client clock trust beyond
 * display — server decides active"). The admin history endpoint reports it so an operator can see, at
 * a glance, whether a row is upcoming, live, or done.
 *
 * <ul>
 *   <li>{@code SCHEDULED} — {@code now < startsAt}: created/queued but not yet visible.
 *   <li>{@code ACTIVE} — {@code startsAt <= now < expiresAt}: currently showing (the only status the
 *       public {@code /alerts/active} read returns).
 *   <li>{@code EXPIRED} — {@code now >= expiresAt}: its window has closed (including one an admin
 *       pulled early via expire-now).
 * </ul>
 */
public enum AlertStatus {
    SCHEDULED,
    ACTIVE,
    EXPIRED;

    /**
     * Derive the status of a window against a reference instant. The window is <b>half-open</b>:
     * {@code startsAt} is inclusive (an alert is ACTIVE the instant it starts) and {@code expiresAt}
     * is exclusive (it is EXPIRED the instant it expires) — the same boundary the {@code active} read
     * query uses ({@code startsAt <= now < expiresAt}), so the derived status and the actual
     * visibility can never disagree at an edge.
     *
     * @param startsAt when the alert becomes visible
     * @param expiresAt when the alert auto-hides
     * @param now the reference instant (always the server clock in production)
     */
    public static AlertStatus at(Instant startsAt, Instant expiresAt, Instant now) {
        if (now.isBefore(startsAt)) {
            return SCHEDULED;
        }
        if (now.isBefore(expiresAt)) {
            return ACTIVE;
        }
        return EXPIRED;
    }
}
