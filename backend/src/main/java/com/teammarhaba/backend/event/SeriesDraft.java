package com.teammarhaba.backend.event;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;

/**
 * Command object for creating a recurring {@link EventSeries} through the admin API (TM-791) — the
 * domain-side shape the {@code api} package's future {@code CreateSeriesRequest} (TM-795) will map
 * onto, so this package never depends on the HTTP DTOs (mirrors {@link EventDraft} for a one-off).
 * Values are expected to arrive already bean-validated at the API edge; {@link EventAdminService}
 * still re-checks the cross-field invariants on the merged occurrence state, exactly as the one-off
 * {@code create} path does.
 *
 * <p><b>The recurrence rule</b> ({@link #frequency}, {@link #interval}, {@link #byWeekday},
 * {@link #untilDate}, {@link #afterN}, {@link #timezone}, {@link #firstStartAt}) is the v1 thin cut:
 * DAILY or WEEKLY(single weekday) only, with at most one end condition ({@code untilDate} OR
 * {@code afterN}). It is turned into a {@code RecurrenceRule} + anchor {@code ZonedDateTime} and fed
 * to the {@code RecurrenceEngine}, which caps the first materialised batch at ≤ 90 days / ≤ 12
 * occurrences.
 *
 * <p><b>The first-occurrence window</b> — {@link #firstStartAt} anchors occurrence #0; the optional
 * {@link #firstEndAt} and the required {@link #firstVisibilityStart}/{@link #firstVisibilityEnd} are
 * the ABSOLUTE instants for that first occurrence, exactly as an admin supplies them for a one-off.
 * {@link EventAdminService} derives each later occurrence's {@code endAt} / visibility window by
 * applying the same offset-from-start these carry — so every occurrence keeps the first one's
 * duration and its visibility lead/lag relative to its own start (the one-off derivation, replayed
 * per occurrence).
 *
 * <p><b>The template snapshot</b> — the remaining fields are the frozen {@link EventDraft} content
 * every generated occurrence is stamped from (heading / description / location / venue / city /
 * capacity / image / the reveal-cutoff-cancellation overrides / price / premium). They are the same
 * fields {@link EventSeries} persists as its template columns and that the per-occurrence
 * {@link EventDraft} is rebuilt from.
 */
public record SeriesDraft(
        // ---- recurrence rule ----
        SeriesFrequency frequency,
        int interval,
        DayOfWeek byWeekday,
        LocalDate untilDate,
        Integer afterN,
        String timezone,
        Instant firstStartAt,
        // ---- first-occurrence window (absolute instants for occurrence #0) ----
        Instant firstEndAt,
        Instant firstVisibilityStart,
        Instant firstVisibilityEnd,
        // ---- template snapshot (frozen EventDraft content) ----
        String heading,
        String description,
        String locationText,
        String city,
        Long venueId,
        Integer capacity,
        String imagePath,
        Integer locationRevealHours,
        Integer bookingCutoffHours,
        Integer cancellationWindowHours,
        Integer pricePence,
        Boolean premium) {}
