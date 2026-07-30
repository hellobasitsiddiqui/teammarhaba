package com.teammarhaba.backend.event.recurrence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Unit tests for the pure {@link RecurrenceEngine} (TM-790) — no Spring, no DB. Pins the v1 thin cut:
 * DAILY + WEEKLY(single weekday), every-N interval, both end conditions (untilDate / afterN), the two
 * horizon caps (90 days / 12 occurrences), DST correctness across a spring-forward and a fall-back in
 * the series timezone, and the DAILY/WEEKLY-only scope guard.
 */
class RecurrenceEngineTest {

    private static final ZoneId LONDON = ZoneId.of("Europe/London");
    private static final ZoneId NEW_YORK = ZoneId.of("America/New_York");

    private final RecurrenceEngine engine = new RecurrenceEngine();

    /** A slice of the instant BEFORE the anchor, so the anchor itself is the first returned occurrence. */
    private static Instant justBefore(ZonedDateTime anchor) {
        return anchor.toInstant().minusSeconds(1);
    }

    // --- DAILY ---

    @Test
    void dailyEveryDayReturnsConsecutiveLocalDays() {
        ZonedDateTime anchor = ZonedDateTime.of(2030, 6, 1, 9, 0, 0, 0, LONDON);
        List<Instant> out = engine.nextOccurrences(RecurrenceRule.daily(1, LONDON), anchor, justBefore(anchor));

        // capped at 12; each 24h wall-clock apart (no DST in this window)
        assertThat(out).hasSize(RecurrenceEngine.MAX_OCCURRENCES);
        assertThat(out.get(0)).isEqualTo(anchor.toInstant());
        for (int i = 0; i < out.size(); i++) {
            assertThat(out.get(i)).isEqualTo(anchor.plusDays(i).toInstant());
        }
    }

    @Test
    void dailyEveryThreeDaysHonoursInterval() {
        ZonedDateTime anchor = ZonedDateTime.of(2030, 6, 1, 9, 0, 0, 0, LONDON);
        List<Instant> out = engine.nextOccurrences(
                RecurrenceRule.daily(3, LONDON).count(4), anchor, justBefore(anchor));

        assertThat(out)
                .containsExactly(
                        anchor.toInstant(),
                        anchor.plusDays(3).toInstant(),
                        anchor.plusDays(6).toInstant(),
                        anchor.plusDays(9).toInstant());
    }

    // --- WEEKLY ---

    @Test
    void weeklyEveryWeekLandsOnTheSameWeekday() {
        // 2030-06-03 is a Monday
        ZonedDateTime anchor = ZonedDateTime.of(2030, 6, 3, 18, 30, 0, 0, LONDON);
        assertThat(anchor.getDayOfWeek()).isEqualTo(DayOfWeek.MONDAY);

        List<Instant> out = engine.nextOccurrences(
                RecurrenceRule.weekly(1, DayOfWeek.MONDAY, LONDON).count(3), anchor, justBefore(anchor));

        assertThat(out)
                .containsExactly(
                        anchor.toInstant(), anchor.plusWeeks(1).toInstant(), anchor.plusWeeks(2).toInstant());
        assertThat(out.stream().map(i -> i.atZone(LONDON).getDayOfWeek()))
                .allMatch(d -> d == DayOfWeek.MONDAY);
    }

    @Test
    void weeklyEveryTwoWeeksHonoursInterval() {
        ZonedDateTime anchor = ZonedDateTime.of(2030, 6, 3, 18, 30, 0, 0, LONDON); // Monday
        List<Instant> out = engine.nextOccurrences(
                RecurrenceRule.weekly(2, DayOfWeek.MONDAY, LONDON).count(3), anchor, justBefore(anchor));

        assertThat(out)
                .containsExactly(
                        anchor.toInstant(), anchor.plusWeeks(2).toInstant(), anchor.plusWeeks(4).toInstant());
    }

    // --- end conditions ---

    @Test
    void untilDateIsInclusiveAndStopsTheSeries() {
        ZonedDateTime anchor = ZonedDateTime.of(2030, 6, 1, 9, 0, 0, 0, LONDON);
        // until 2030-06-04 inclusive → dates 06-01, 06-02, 06-03, 06-04 = 4 occurrences
        List<Instant> out = engine.nextOccurrences(
                RecurrenceRule.daily(1, LONDON).until(LocalDate.of(2030, 6, 4)), anchor, justBefore(anchor));

        assertThat(out)
                .containsExactly(
                        anchor.toInstant(),
                        anchor.plusDays(1).toInstant(),
                        anchor.plusDays(2).toInstant(),
                        anchor.plusDays(3).toInstant());
    }

    @Test
    void afterNCapsTheTotalCountAndIsMeasuredFromTheAnchorNotTheLowerBound() {
        ZonedDateTime anchor = ZonedDateTime.of(2030, 6, 1, 9, 0, 0, 0, LONDON);
        // 5-occurrence series (dates 06-01..06-05). Lower bound is midway through 06-03 (between #3 and
        // #4), so #1..#3 are behind us and only #4 (06-04) and #5 (06-05) remain — the count is anchored
        // to the series, not re-counted from the lower bound.
        Instant from = anchor.plusDays(2).plusHours(1).toInstant(); // 06-03 10:00
        List<Instant> out =
                engine.nextOccurrences(RecurrenceRule.daily(1, LONDON).count(5), anchor, from);

        assertThat(out)
                .containsExactly(anchor.plusDays(3).toInstant(), anchor.plusDays(4).toInstant());
    }

    // --- DST correctness ---

    @Test
    void dailyPreservesLocalWallClockAcrossSpringForward() {
        // UK spring-forward: 2031-03-30 01:00 → 02:00. A 09:00-London daily series must stay 09:00
        // local either side, so the UTC instant shifts from 09:00Z (GMT) to 08:00Z (BST).
        ZonedDateTime anchor = ZonedDateTime.of(2031, 3, 29, 9, 0, 0, 0, LONDON);
        List<Instant> out = engine.nextOccurrences(
                RecurrenceRule.daily(1, LONDON).count(3), anchor, justBefore(anchor));

        assertThat(out.get(0)).isEqualTo(Instant.parse("2031-03-29T09:00:00Z")); // GMT
        assertThat(out.get(1)).isEqualTo(Instant.parse("2031-03-30T08:00:00Z")); // BST (clocks jumped)
        assertThat(out.get(2)).isEqualTo(Instant.parse("2031-03-31T08:00:00Z"));
        // every occurrence is still 09:00 wall-clock in London
        assertThat(out.stream().map(i -> i.atZone(LONDON).getHour())).allMatch(h -> h == 9);
    }

    @Test
    void dailyPreservesLocalWallClockAcrossFallBack() {
        // UK fall-back: 2031-10-26 02:00 → 01:00. 09:00-London stays 09:00 local; UTC shifts 08:00Z→09:00Z.
        ZonedDateTime anchor = ZonedDateTime.of(2031, 10, 25, 9, 0, 0, 0, LONDON);
        List<Instant> out = engine.nextOccurrences(
                RecurrenceRule.daily(1, LONDON).count(3), anchor, justBefore(anchor));

        assertThat(out.get(0)).isEqualTo(Instant.parse("2031-10-25T08:00:00Z")); // BST
        assertThat(out.get(1)).isEqualTo(Instant.parse("2031-10-26T09:00:00Z")); // GMT (clocks fell back)
        assertThat(out.get(2)).isEqualTo(Instant.parse("2031-10-27T09:00:00Z"));
        assertThat(out.stream().map(i -> i.atZone(LONDON).getHour())).allMatch(h -> h == 9);
    }

    @Test
    void dstIsResolvedInTheSeriesZoneNotUtc() {
        // Same wall-clock rule in New York: spring-forward 2031-03-09 02:00→03:00.
        ZonedDateTime anchor = ZonedDateTime.of(2031, 3, 8, 9, 0, 0, 0, NEW_YORK);
        List<Instant> out = engine.nextOccurrences(
                RecurrenceRule.daily(1, NEW_YORK).count(2), anchor, justBefore(anchor));

        assertThat(out.get(0)).isEqualTo(Instant.parse("2031-03-08T14:00:00Z")); // EST (UTC-5)
        assertThat(out.get(1)).isEqualTo(Instant.parse("2031-03-09T13:00:00Z")); // EDT (UTC-4)
        assertThat(out.stream().map(i -> i.atZone(NEW_YORK).getHour())).allMatch(h -> h == 9);
    }

    // --- horizon caps ---

    @Test
    void occurrenceCapStopsAtTwelveEvenForAnOpenEndedSeries() {
        ZonedDateTime anchor = ZonedDateTime.of(2030, 6, 1, 9, 0, 0, 0, LONDON);
        // daily open-ended within the horizon would be 90+ candidates; cap is 12
        List<Instant> out = engine.nextOccurrences(RecurrenceRule.daily(1, LONDON), anchor, justBefore(anchor));
        assertThat(out).hasSize(RecurrenceEngine.MAX_OCCURRENCES);
    }

    @Test
    void horizonCapStopsAtNinetyDaysAhead() {
        // weekly open-ended: 12 caps would reach 84 days, but push interval so the horizon bites first.
        ZonedDateTime anchor = ZonedDateTime.of(2030, 6, 3, 9, 0, 0, 0, LONDON); // Monday
        Instant from = justBefore(anchor);
        List<Instant> out =
                engine.nextOccurrences(RecurrenceRule.weekly(2, DayOfWeek.MONDAY, LONDON), anchor, from);

        Instant horizonEnd = from.plus(Duration.ofDays(RecurrenceEngine.MAX_HORIZON_DAYS));
        // every returned occurrence is within 90 days of the lower bound...
        assertThat(out).allMatch(i -> i.isBefore(horizonEnd));
        // ...and the NEXT step (last + 14 days) would be beyond it, proving the horizon (not the count) capped us
        assertThat(out).hasSizeLessThan(RecurrenceEngine.MAX_OCCURRENCES);
        Instant afterLast = out.get(out.size() - 1).atZone(LONDON).plusWeeks(2).toInstant();
        assertThat(afterLast).isAfterOrEqualTo(horizonEnd);
    }

    @Test
    void fromInstantIsExclusiveLowerBound() {
        ZonedDateTime anchor = ZonedDateTime.of(2030, 6, 1, 9, 0, 0, 0, LONDON);
        // from == the anchor instant exactly → the anchor is NOT returned (strictly after)
        List<Instant> out = engine.nextOccurrences(
                RecurrenceRule.daily(1, LONDON).count(3), anchor, anchor.toInstant());
        assertThat(out)
                .containsExactly(anchor.plusDays(1).toInstant(), anchor.plusDays(2).toInstant());
    }

    // --- scope guards ---

    @Test
    void weeklyRuleRejectsAnchorNotOnByWeekday() {
        ZonedDateTime tuesday = ZonedDateTime.of(2030, 6, 4, 9, 0, 0, 0, LONDON); // Tuesday
        RecurrenceRule mondayRule = RecurrenceRule.weekly(1, DayOfWeek.MONDAY, LONDON);
        assertThatThrownBy(() -> engine.nextOccurrences(mondayRule, tuesday, justBefore(tuesday)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("byWeekday");
    }

    @Test
    void mismatchedSeriesStartZoneIsRejected() {
        ZonedDateTime utcAnchor = ZonedDateTime.of(2030, 6, 1, 9, 0, 0, 0, ZoneOffset.UTC);
        RecurrenceRule londonRule = RecurrenceRule.daily(1, LONDON);
        assertThatThrownBy(() -> engine.nextOccurrences(londonRule, utcAnchor, justBefore(utcAnchor)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("zone");
    }
}
