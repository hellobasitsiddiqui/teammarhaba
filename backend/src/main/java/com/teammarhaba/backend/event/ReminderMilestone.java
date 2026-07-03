package com.teammarhaba.backend.event;

import java.time.Duration;
import java.time.Instant;

/**
 * The two reminder points before an event's start that the scheduler pushes at (TM-394): 24 hours
 * out and 1 hour out. Stored on {@link EventReminderSend} as VARCHAR via {@code EnumType.STRING}
 * (same convention as {@code events.status}), so the marker table reads plainly and values can be
 * added without a DB type change.
 *
 * <p>Each milestone knows its offset (so {@link #fireAt} is the single definition of "when is this
 * reminder due") and its title prefix. The prefixes are deliberately fuzzy — "Reminder" /
 * "Starting soon" — rather than "in 24 hours" / "in 1 hour", so a reminder delivered late (e.g.
 * after scheduler downtime, but always still before the start — the service gates on that) never
 * states a countdown that has since become wrong. The precise start time lives in the body as the
 * event's local time.
 */
public enum ReminderMilestone {

    /** The day-before nudge, due from {@code startAt - 24h}. */
    T_MINUS_24H(Duration.ofHours(24), "Reminder: "),

    /** The final nudge, due from {@code startAt - 1h}. */
    T_MINUS_1H(Duration.ofHours(1), "Starting soon: ");

    /** The widest milestone offset — the scanner's look-ahead horizon (events starting within it). */
    public static final Duration SCAN_HORIZON = Duration.ofHours(24);

    private final Duration offset;
    private final String titlePrefix;

    ReminderMilestone(Duration offset, String titlePrefix) {
        this.offset = offset;
        this.titlePrefix = titlePrefix;
    }

    /** How long before the event start this reminder is due. */
    public Duration offset() {
        return offset;
    }

    /** Prefix for the push title, ahead of the event heading. */
    public String titlePrefix() {
        return titlePrefix;
    }

    /** The instant this milestone becomes due for an event starting at {@code startAt}. */
    public Instant fireAt(Instant startAt) {
        return startAt.minus(offset);
    }
}
