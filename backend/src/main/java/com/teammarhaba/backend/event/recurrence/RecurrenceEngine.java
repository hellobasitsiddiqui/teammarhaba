package com.teammarhaba.backend.event.recurrence;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * The pure occurrence-date engine (TM-790): given a {@link RecurrenceRule}, the series anchor (its
 * first start, which fixes the local date and time-of-day), and a lower bound, it expands the series
 * into its next start instants. DB-free, Spring-free and side-effect-free — the same shape as the
 * event policy classes (e.g. {@link com.teammarhaba.backend.event.BookingCutoffPolicy}), so it is
 * exercised entirely by fast unit tests.
 *
 * <p><b>DST correctness.</b> Occurrences are stepped in the series {@link RecurrenceRule#zone() zone}
 * as {@link ZonedDateTime}s at a fixed local time-of-day, never by adding fixed {@link Duration}s to
 * an {@link Instant}. So "every day at 09:00 London" stays 09:00 <i>local</i> across the spring-forward
 * and fall-back transitions — the wall-clock time is preserved and only the resulting UTC instant
 * shifts. When a local time is skipped or doubled by a transition, {@link ZonedDateTime#of} resolves
 * it with the java.time defaults (gap → pushed forward by the gap; overlap → the earlier offset).
 *
 * <p><b>Horizon caps.</b> Expansion always stops at the FIRST of: {@code <= 90 days} ahead of the
 * lower bound, {@code <= 12} occurrences returned, or the rule's end condition
 * ({@link RecurrenceRule#untilDate()} / {@link RecurrenceRule#afterN()}). {@code afterN} counts from
 * the series anchor (occurrence #1 = the anchor), not from the lower bound — so a "5 occurrences"
 * series that has already emitted 3 before {@code fromInstant} yields at most 2 more.
 *
 * <p><b>Scope (v1 thin cut).</b> DAILY and WEEKLY(single weekday) only. Any other frequency reaching
 * the engine is a programming error and throws — monthly / multi-weekday are deferred to wave-3b and
 * are deliberately unimplemented, not silently no-op.
 */
public final class RecurrenceEngine {

    /** Hard upper bound on how far ahead of the lower bound the engine will look. */
    public static final int MAX_HORIZON_DAYS = 90;

    /** Hard upper bound on how many occurrences a single expansion returns. */
    public static final int MAX_OCCURRENCES = 12;

    /**
     * Next start instants for {@code rule}, anchored at {@code seriesStart} (occurrence #1), that fall
     * strictly after {@code fromInstant}, bounded by the {@link #MAX_HORIZON_DAYS}/
     * {@link #MAX_OCCURRENCES} caps and the rule's end condition.
     *
     * @param rule        the recurrence rule (DAILY or WEEKLY-single-weekday)
     * @param seriesStart the first occurrence — fixes the local date and time-of-day the series lands
     *                    on; its zone must equal {@code rule.zone()}
     * @param fromInstant lower bound; only occurrences strictly after this instant are returned
     * @return up to {@link #MAX_OCCURRENCES} start instants, ascending, all within the horizon and end
     *     condition; never null
     */
    public List<Instant> nextOccurrences(RecurrenceRule rule, ZonedDateTime seriesStart, Instant fromInstant) {
        if (rule == null || seriesStart == null || fromInstant == null) {
            throw new IllegalArgumentException("rule, seriesStart and fromInstant are all required");
        }
        ZoneId zone = rule.zone();
        if (!seriesStart.getZone().equals(zone)) {
            throw new IllegalArgumentException(
                    "seriesStart zone " + seriesStart.getZone() + " must equal rule zone " + zone);
        }

        LocalTime timeOfDay = seriesStart.toLocalTime();
        LocalDate anchorDate = firstCandidateDate(rule, seriesStart.toLocalDate());
        Instant horizonEnd = fromInstant.plus(Duration.ofDays(MAX_HORIZON_DAYS));

        // Fast-forward the cursor to the last candidate at/before fromInstant's local date, so a series
        // anchored far in the past doesn't loop day-by-day up to now. Whole steps only, so the local
        // time-of-day cadence and the 1-based occurrence index are preserved exactly.
        long stepDays = stepDays(rule);
        LocalDate fromLocalDate = fromInstant.atZone(zone).toLocalDate();
        long stepsToSkip = 0;
        if (fromLocalDate.isAfter(anchorDate)) {
            stepsToSkip = (fromLocalDate.toEpochDay() - anchorDate.toEpochDay()) / stepDays;
        }
        LocalDate cursorDate = anchorDate.plusDays(stepsToSkip * stepDays);
        // 1-based occurrence index within the whole series; anchor date is #1.
        long index = stepsToSkip + 1;

        List<Instant> out = new ArrayList<>();

        while (out.size() < MAX_OCCURRENCES) {
            if (rule.afterN() != null && index > rule.afterN()) {
                break; // count exhausted
            }
            if (rule.untilDate() != null && cursorDate.isAfter(rule.untilDate())) {
                break; // past the inclusive until-date
            }

            // Resolve this candidate's start instant in the series zone (DST-correct). The anchor
            // occurrence (index 1, cursor still on the anchor's own date) is emitted as the anchor's
            // OWN instant rather than re-resolved from local date + time-of-day: on the fall-back
            // doubled hour ZonedDateTime.of picks the EARLIER offset, so an anchor created on the later
            // offset would be re-resolved an hour early — landing at or before fromInstant (the anchor
            // minus a sliver) and being dropped, silently losing occurrence #0. Using the anchor's own
            // instant preserves exactly what the caller anchored on. Later candidates keep the
            // wall-clock-preserving local resolution (that IS the intended DST behaviour for them).
            Instant occurrence = (index == 1 && cursorDate.equals(seriesStart.toLocalDate()))
                    ? seriesStart.toInstant()
                    : ZonedDateTime.of(cursorDate, timeOfDay, zone).toInstant();

            if (!occurrence.isBefore(horizonEnd)) {
                break; // beyond the 90-day horizon; later candidates are only further out
            }
            if (occurrence.isAfter(fromInstant)) {
                out.add(occurrence);
            }

            cursorDate = cursorDate.plusDays(stepDays);
            index++;
        }
        return out;
    }

    /** The first candidate date >= the anchor date that the rule actually lands on. */
    private LocalDate firstCandidateDate(RecurrenceRule rule, LocalDate anchorDate) {
        return switch (rule.frequency()) {
            case DAILY -> anchorDate;
            case WEEKLY -> {
                if (anchorDate.getDayOfWeek() != rule.byWeekday()) {
                    // A WEEKLY anchor is expected to already sit on byWeekday; guard the invariant
                    // rather than silently realigning to a different day.
                    throw new IllegalArgumentException(
                            "WEEKLY seriesStart day " + anchorDate.getDayOfWeek() + " != byWeekday " + rule.byWeekday());
                }
                yield anchorDate;
            }
        };
    }

    /** Days between successive occurrences: {@code interval} for DAILY, {@code 7 * interval} for WEEKLY. */
    private long stepDays(RecurrenceRule rule) {
        return switch (rule.frequency()) {
            case DAILY -> rule.interval();
            case WEEKLY -> 7L * rule.interval();
        };
    }
}
