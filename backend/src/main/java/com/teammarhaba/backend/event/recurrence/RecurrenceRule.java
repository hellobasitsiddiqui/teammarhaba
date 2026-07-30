package com.teammarhaba.backend.event.recurrence;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Objects;

/**
 * A pure, DB-free recurrence rule (TM-790) — the value model consumed by {@link RecurrenceEngine} to
 * expand a series into its next start instants. Mirrors the policy-class style of
 * {@link com.teammarhaba.backend.event.BookingCutoffPolicy}: no JPA, no persistence, no Spring — just
 * an immutable, validated value type.
 *
 * <p><b>v1 thin cut (this wave):</b> {@link RecurrenceFrequency#DAILY} and
 * {@link RecurrenceFrequency#WEEKLY} (a <i>single</i> {@code byWeekday}) only. Monthly, multi-weekday
 * sets, edit-scope and cloning are deferred to wave-3b — the fields below are shaped to stay
 * extensible ({@link #rruleRaw} is a nullable escape hatch for a future RFC-5545 string), but the
 * engine only implements what is in scope, and this record's construction is validated against the
 * in-scope shape.
 *
 * <p><b>End condition</b> is exactly one of {@code untilDate} (inclusive last date, in {@link #zone})
 * or {@code afterN} (a maximum occurrence count). Both null = open-ended (still bounded by the
 * engine's horizon caps). Supplying both is rejected — an ambiguous rule is a programming error, not
 * a runtime state.
 *
 * @param frequency  DAILY or WEEKLY (required)
 * @param interval   every-N: repeat every {@code interval} periods, {@code >= 1}
 * @param byWeekday  the single weekday a WEEKLY series lands on; required for WEEKLY, must be null for
 *                   DAILY
 * @param untilDate  inclusive last date (in {@link #zone}) the series may produce, or null
 * @param afterN     maximum number of occurrences ({@code >= 1}), or null
 * @param zone       the series timezone occurrences are resolved in (DST-correct), required
 * @param rruleRaw   nullable, unused-in-v1 escape hatch for a future raw RFC-5545 RRULE string; kept
 *                   so the model stays forward-extensible without a reshape
 */
public record RecurrenceRule(
        RecurrenceFrequency frequency,
        int interval,
        DayOfWeek byWeekday,
        LocalDate untilDate,
        Integer afterN,
        ZoneId zone,
        String rruleRaw) {

    public RecurrenceRule {
        Objects.requireNonNull(frequency, "frequency is required");
        Objects.requireNonNull(zone, "zone is required");
        if (interval < 1) {
            throw new IllegalArgumentException("interval must be >= 1, was " + interval);
        }
        if (afterN != null && afterN < 1) {
            throw new IllegalArgumentException("afterN must be >= 1 when set, was " + afterN);
        }
        if (untilDate != null && afterN != null) {
            throw new IllegalArgumentException("end condition is at most one of untilDate or afterN, not both");
        }
        switch (frequency) {
            case WEEKLY -> {
                if (byWeekday == null) {
                    throw new IllegalArgumentException("WEEKLY requires a byWeekday");
                }
            }
            case DAILY -> {
                if (byWeekday != null) {
                    throw new IllegalArgumentException("DAILY must not set byWeekday");
                }
            }
        }
    }

    /** A DAILY rule, every {@code interval} day(s), open-ended, in {@code zone}. */
    public static RecurrenceRule daily(int interval, ZoneId zone) {
        return new RecurrenceRule(RecurrenceFrequency.DAILY, interval, null, null, null, zone, null);
    }

    /** A WEEKLY rule on {@code weekday}, every {@code interval} week(s), open-ended, in {@code zone}. */
    public static RecurrenceRule weekly(int interval, DayOfWeek weekday, ZoneId zone) {
        return new RecurrenceRule(RecurrenceFrequency.WEEKLY, interval, weekday, null, null, zone, null);
    }

    /** This rule with an inclusive {@code untilDate} end condition (clears any {@code afterN}). */
    public RecurrenceRule until(LocalDate untilDate) {
        return new RecurrenceRule(frequency, interval, byWeekday, untilDate, null, zone, rruleRaw);
    }

    /** This rule with an {@code afterN}-occurrence end condition (clears any {@code untilDate}). */
    public RecurrenceRule count(int afterN) {
        return new RecurrenceRule(frequency, interval, byWeekday, null, afterN, zone, rruleRaw);
    }
}
