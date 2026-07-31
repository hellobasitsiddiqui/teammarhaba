package com.teammarhaba.backend.api;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.teammarhaba.backend.event.SeriesDraft;
import com.teammarhaba.backend.event.SeriesFrequency;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;

/**
 * Body for {@code POST /api/v1/admin/events/series} (TM-795, recurring events v1) — the input to
 * {@link com.teammarhaba.backend.event.EventAdminService#createSeries createSeries}. It mirrors
 * {@link CreateEventRequest}'s shape and validation style: the field caps match the {@code events}
 * template columns, and the cross-field rules are {@code @AssertTrue} properties so every violation
 * surfaces through the standard RFC-7807 validation body. Maps onto the domain-side
 * {@link SeriesDraft} so the {@code event} package never depends on this HTTP DTO.
 *
 * <p><b>v1 THIN CUT.</b> Only {@link SeriesFrequency#DAILY} and {@link SeriesFrequency#WEEKLY} exist
 * on the enum, so an unknown cadence (e.g. {@code MONTHLY}) fails JSON binding with a clean 400 — no
 * further guard needed. WEEKLY pins to a single {@link #byWeekday}; multi-weekday / monthly are 3b.
 * The end condition is <b>exactly one</b> of {@link #untilDate} or {@link #afterN} (both or neither is
 * a 400), matching {@link com.teammarhaba.backend.event.recurrence.RecurrenceRule}'s invariant so the
 * engine is never handed an ambiguous rule.
 *
 * <p><b>The first occurrence's window</b> ({@link #firstStartAt}, {@link #firstEndAt},
 * {@link #firstVisibilityStart}, {@link #firstVisibilityEnd}) is supplied as ABSOLUTE instants exactly
 * as a one-off event is; {@code createSeries} turns them into offsets and re-applies them per
 * occurrence. The edge validation here matches the one-off {@code create} path (start &lt; end,
 * visibilityStart ≤ start ≤ visibilityEnd) plus a start-in-the-future check, which TM-791 flagged as
 * landing at this API edge.
 *
 * @param frequency        how often the series repeats — {@code DAILY} or {@code WEEKLY} only
 * @param interval         every-N step (≥ 1): {@code 1} = every day/week, {@code 2} = every other, …
 * @param byWeekday        the ISO weekday a WEEKLY series lands on ({@code MONDAY}…{@code SUNDAY});
 *     required for WEEKLY, must be omitted for DAILY, and must equal {@link #firstStartAt}'s weekday in
 *     {@link #timezone}
 * @param untilDate        inclusive local calendar end of the recurrence; the {@code untilDate} end
 *     condition. Exactly one of this or {@link #afterN}
 * @param afterN           maximum number of occurrences (≥ 1); the {@code count} end condition. Exactly
 *     one of this or {@link #untilDate}
 * @param timezone         IANA timezone id the recurrence is computed in (e.g. {@code Europe/London})
 * @param firstStartAt     when the first occurrence starts (UTC instant); the series anchor. Must be in
 *     the future
 * @param firstEndAt       optional end instant of the first occurrence; omitted = open-ended
 *     occurrences. When set, must be after {@link #firstStartAt}
 * @param firstVisibilityStart from when the first occurrence appears in the public listing
 * @param firstVisibilityEnd   until when the first occurrence appears
 * @param heading          short display title of every occurrence (≤ 120)
 * @param description      full body text (≤ 5000)
 * @param locationText     free-text venue line, always present (≤ 500)
 * @param city             optional coarse locality (≤ 120)
 * @param venueId          optional reusable-venue id (validated in {@code EventAdminService}); omitted =
 *     a one-off free-text location
 * @param capacity         max GOING attendees per occurrence, ≥ 1; omitted = unlimited
 * @param imagePath        optional storage path of the occurrence image ({@code event-images/…})
 * @param locationRevealHours optional per-occurrence reveal override in hours (1..8760); omitted =
 *     inherit
 * @param bookingCutoffHours   optional per-occurrence booking-cutoff override in hours (0..8760);
 *     omitted = inherit
 * @param cancellationWindowHours optional per-occurrence cancellation-window override in hours
 *     (0..8760); omitted = inherit
 * @param pricePence       optional ticket price per occurrence in pence, ≥ 0; omitted = the £5 default
 * @param premium          optional premium-gating flag; omitted = {@code false}
 */
public record CreateSeriesRequest(
        // ---- recurrence rule ----
        @NotNull SeriesFrequency frequency,
        @Min(1) int interval,
        DayOfWeek byWeekday,
        LocalDate untilDate,
        @Min(1) Integer afterN,
        @NotBlank @Size(max = 64) String timezone,
        @NotNull Instant firstStartAt,
        // ---- first-occurrence window (absolute instants for occurrence #0) ----
        Instant firstEndAt,
        @NotNull Instant firstVisibilityStart,
        @NotNull Instant firstVisibilityEnd,
        // ---- template snapshot ----
        @NotBlank @Size(max = 120) String heading,
        @NotBlank @Size(max = 5000) String description,
        @NotBlank @Size(max = 500) String locationText,
        @Size(max = 120) String city,
        @Min(1) Long venueId,
        @Min(1) Integer capacity,
        @Size(max = 512)
                @Pattern(
                        regexp = "event-images/[A-Za-z0-9._-]+",
                        message = "must be a storage object path like event-images/{eventId}")
                String imagePath,
        @Min(1) @Max(8760) Integer locationRevealHours,
        @Min(0) @Max(8760) Integer bookingCutoffHours,
        @Min(0) @Max(8760) Integer cancellationWindowHours,
        @Min(0) Integer pricePence,
        Boolean premium) {

    /** The timezone must be a real IANA zone id — bad ids would break every occurrence's rendering. */
    @JsonIgnore
    @AssertTrue(message = "timezone must be a valid IANA timezone id (e.g. Europe/London)")
    public boolean isTimezoneValid() {
        return timezone == null || timezone.isBlank() || ZoneId.getAvailableZoneIds().contains(timezone);
    }

    /** Exactly one end condition: untilDate XOR afterN (both or neither is ambiguous, RecurrenceRule rejects it). */
    @JsonIgnore
    @AssertTrue(message = "provide exactly one end condition: either untilDate or afterN, not both or neither")
    public boolean isEndConditionExactlyOne() {
        return (untilDate == null) ^ (afterN == null);
    }

    /** byWeekday is required for WEEKLY and must be omitted for DAILY (matches RecurrenceRule). */
    @JsonIgnore
    @AssertTrue(message = "byWeekday is required for WEEKLY and must be omitted for DAILY")
    public boolean isByWeekdayConsistentWithFrequency() {
        if (frequency == null) {
            return true; // @NotNull reports the missing frequency
        }
        return switch (frequency) {
            case WEEKLY -> byWeekday != null;
            case DAILY -> byWeekday == null;
        };
    }

    /**
     * For WEEKLY, the supplied byWeekday must be the weekday {@link #firstStartAt} actually falls on in
     * {@link #timezone} — the recurrence engine anchors the series on {@code firstStartAt} and refuses
     * to silently realign it to a different day (it would otherwise throw and surface as a 500). Checked
     * here so a mismatch is a clean 400 at the edge.
     */
    @JsonIgnore
    @AssertTrue(message = "byWeekday must match the weekday of firstStartAt in the given timezone")
    public boolean isByWeekdayMatchingFirstStart() {
        if (frequency != SeriesFrequency.WEEKLY || byWeekday == null || firstStartAt == null || !isTimezoneValid()) {
            return true; // other rules report the real problem; nothing to cross-check here
        }
        return firstStartAt.atZone(ZoneId.of(timezone)).getDayOfWeek() == byWeekday;
    }

    /** An end, when given, must come after the start (the first occurrence's duration). */
    @JsonIgnore
    @AssertTrue(message = "firstEndAt must be after firstStartAt")
    public boolean isFirstEndAfterStart() {
        return firstEndAt == null || firstStartAt == null || firstEndAt.isAfter(firstStartAt);
    }

    /** The first occurrence's visibility window must bracket its start: visibilityStart ≤ start ≤ visibilityEnd. */
    @JsonIgnore
    @AssertTrue(message = "firstVisibilityStart must be at or before firstStartAt, which must be at or before firstVisibilityEnd")
    public boolean isFirstVisibilityWindowOrdered() {
        if (firstStartAt == null || firstVisibilityStart == null || firstVisibilityEnd == null) {
            return true; // @NotNull reports the missing instants
        }
        return !firstVisibilityStart.isAfter(firstStartAt) && !firstStartAt.isAfter(firstVisibilityEnd);
    }

    /**
     * The series anchor must be in the future — a series whose first occurrence is already in the past
     * has nothing left to schedule. Uses {@link Instant#now()} rather than a wall-clock field so this
     * stays a pure request-edge check (the engine's horizon caps handle everything downstream).
     */
    @JsonIgnore
    @AssertTrue(message = "firstStartAt must be in the future")
    public boolean isFirstStartInTheFuture() {
        return firstStartAt == null || firstStartAt.isAfter(Instant.now());
    }

    /**
     * When an {@link #untilDate} end condition is given, it must not fall before the anchor's own local
     * calendar date — an until-date earlier than the first occurrence yields a zero-occurrence series,
     * which is almost certainly a client mistake and should be a clean 400 rather than a silently empty
     * series. Compared in {@link #timezone} (the zone the recurrence is computed in) so the local
     * calendar comparison matches how the engine steps dates. Skipped when the timezone is invalid (the
     * timezone rule reports that) so this never throws on a bad zone id.
     */
    @JsonIgnore
    @AssertTrue(message = "untilDate must not be before the first occurrence's date")
    public boolean isUntilDateNotBeforeFirstStart() {
        if (untilDate == null || firstStartAt == null || !isTimezoneValid()) {
            return true; // other rules report the real problem; nothing to cross-check here
        }
        LocalDate firstStartDate = firstStartAt.atZone(ZoneId.of(timezone)).toLocalDate();
        return !untilDate.isBefore(firstStartDate);
    }

    /** Map onto the domain-side command object ({@code event} package stays free of api DTOs). */
    SeriesDraft toDraft() {
        return new SeriesDraft(
                frequency,
                interval,
                byWeekday,
                untilDate,
                afterN,
                timezone,
                firstStartAt,
                firstEndAt,
                firstVisibilityStart,
                firstVisibilityEnd,
                heading,
                description,
                locationText,
                city,
                venueId,
                capacity,
                imagePath,
                locationRevealHours,
                bookingCutoffHours,
                cancellationWindowHours,
                pricePence,
                premium);
    }
}
