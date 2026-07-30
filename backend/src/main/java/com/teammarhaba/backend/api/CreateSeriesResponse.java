package com.teammarhaba.backend.api;

import com.teammarhaba.backend.event.EventSeries;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

/**
 * Response body for {@code POST /api/v1/admin/events/series} (TM-795): the created recurring
 * {@link EventSeries} summarised, plus the concrete {@link EventResponse} occurrences
 * {@link com.teammarhaba.backend.event.EventAdminService#createSeries createSeries} materialised in the
 * first in-horizon batch. A deliberate projection of {@link EventSeries} — the cadence + template facts
 * the admin console needs to confirm what it just created — and none of the internals ({@code version},
 * {@code deletedAt}).
 *
 * <p>The {@link #occurrences} are the ordinary admin {@link EventResponse}s (zero-based order), so the
 * console can render the generated events directly. {@link #occurrenceCount} is their number (the
 * batch size, ≤ 12 per the engine's horizon cap) — a convenience so a caller need not count the list.
 *
 * <p>All instants are UTC; clients pair them with {@link #timezone} (IANA id) to render local times.
 *
 * @param id                     database id of the created series — the handle for future series
 *     endpoints (3b)
 * @param frequency              how often it repeats ({@code DAILY} | {@code WEEKLY})
 * @param interval               every-N step
 * @param byWeekday              the ISO weekday number (1 = Monday … 7 = Sunday) a WEEKLY series lands
 *     on; {@code null} for DAILY
 * @param untilDate              inclusive local calendar end of the recurrence ({@code null} = the
 *     afterN end condition instead)
 * @param occurrenceCount        total-occurrence cap from {@code afterN} ({@code null} = the untilDate
 *     end condition instead) — the SERIES cap, distinct from the batch size below
 * @param timezone               IANA timezone id the recurrence is computed in
 * @param firstStartAt           the anchor: the first occurrence's start instant (UTC)
 * @param horizonGeneratedUntil  how far occurrences have been materialised (the last generated start)
 * @param status                 {@code ACTIVE} on creation
 * @param heading                the template heading every occurrence carries
 * @param createdBy              {@code users.id} of the creating admin
 * @param createdAt              DB-authoritative creation instant
 * @param occurrenceBatchSize    number of occurrences materialised in this batch (= {@code occurrences.size()})
 * @param occurrences            the generated occurrences as admin event projections, in occurrence order
 */
public record CreateSeriesResponse(
        Long id,
        String frequency,
        int interval,
        Integer byWeekday,
        LocalDate untilDate,
        Integer occurrenceCount,
        String timezone,
        Instant firstStartAt,
        Instant horizonGeneratedUntil,
        String status,
        String heading,
        Long createdBy,
        Instant createdAt,
        int occurrenceBatchSize,
        List<EventResponse> occurrences) {

    /**
     * Project the persisted series + its generated occurrence projections into the API response. The
     * caller (the controller) builds the per-occurrence {@link EventResponse}s with the reveal /
     * cutoff / cancellation policies, exactly as the create-event path does, and passes them in ordered.
     */
    public static CreateSeriesResponse from(EventSeries series, List<EventResponse> occurrences) {
        return new CreateSeriesResponse(
                series.getId(),
                series.getFrequency().name(),
                series.getInterval(),
                series.getByWeekday(),
                series.getUntilDate(),
                series.getOccurrenceCount(),
                series.getTimezone(),
                series.getFirstStartAt(),
                series.getHorizonGeneratedUntil(),
                series.getStatus().name(),
                series.getTemplateHeading(),
                series.getCreatedBy(),
                series.getCreatedAt(),
                occurrences.size(),
                occurrences);
    }
}
