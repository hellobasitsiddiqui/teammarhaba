package com.teammarhaba.backend.event;

/**
 * How often a recurring {@link EventSeries} repeats (TM-789, recurring events v1).
 *
 * <p><b>v1 thin cut ships only {@link #DAILY} and {@link #WEEKLY}.</b> The enum is deliberately left
 * open (stored as {@code VARCHAR} via {@code EnumType.STRING}, same convention as {@link EventStatus}
 * / {@code users.role}) so 3b can add {@code MONTHLY} (and any richer cadence) without a DB type
 * change — but the recurrence engine (TM-790) must reject anything outside this v1 set until then.
 */
public enum SeriesFrequency {
    /** Repeat every {@code interval} days. */
    DAILY,
    /** Repeat every {@code interval} weeks, optionally pinned to a weekday ({@code by_weekday}). */
    WEEKLY
}
