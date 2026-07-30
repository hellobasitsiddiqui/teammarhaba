package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Verifies the {@link EventSeries} mapping + {@link EventSeriesRepository} against a real Postgres
 * (Testcontainers), and the {@code events → event_series} reference (TM-789, recurring events v1).
 *
 * <p>The context booting at all proves Hibernate {@code validate} agrees with the
 * {@code V56__create_event_series} / {@code V57__events_series_reference} migrations. The tests then
 * cover: the recurrence + template round-trip, the house soft-delete via {@code @SQLRestriction}, the
 * admin-only {@link EventSeriesRepository#findByIdIncludingDeleted} exception that returns a
 * soft-deleted series, and {@code Event.seriesId}/{@code occurrenceIndex}/{@code seriesDetached}
 * round-tripping on a generated occurrence.
 *
 * <p>The suite shares one database across test classes, so assertions use contains/doesNotContain or
 * this class's own rows rather than exact table contents.
 */
class EventSeriesRepositoryIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private EventSeriesRepository series;

    @Autowired
    private EventRepository events;

    @Autowired
    private UserRepository users;

    @Autowired
    private JdbcTemplate jdbc;

    private Long creatorId;

    @BeforeEach
    void seedCreator() {
        creatorId = users.findByFirebaseUid("event-series-it-uid")
                .orElseGet(() -> users.saveAndFlush(new User("event-series-it-uid", "series@example.com", "Seeder")))
                .getId();
    }

    private EventSeries newWeeklySeries(String heading) {
        Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
        EventSeries s = new EventSeries(
                SeriesFrequency.WEEKLY,
                2,
                "Europe/London",
                now.plus(Duration.ofDays(3)),
                heading,
                "A recurring friendly meetup.",
                "Marhaba Cafe, 12 High St",
                creatorId,
                now);
        s.setByWeekday(3); // Wednesday
        s.setUntilDate(LocalDate.now().plusMonths(2));
        s.setOccurrenceCount(8);
        s.setTemplateCapacity(30);
        s.setTemplatePricePence(700);
        s.setTemplatePremium(true);
        s.setTemplateCity("London");
        s.setTemplateBookingCutoffHours(2);
        return s;
    }

    /** The recurrence rule + template snapshot + house defaults round-trip through Postgres. */
    @Test
    void persistsAndRoundTripsRecurrenceRuleAndTemplateSnapshot() {
        EventSeries saved = series.saveAndFlush(newWeeklySeries("Weekly Round-Trip TM789"));

        EventSeries loaded = series.findById(saved.getId()).orElseThrow();
        assertThat(loaded.getFrequency()).isEqualTo(SeriesFrequency.WEEKLY);
        assertThat(loaded.getInterval()).isEqualTo(2);
        assertThat(loaded.getByWeekday()).isEqualTo(3);
        assertThat(loaded.getByMonthDay()).isNull(); // 3b placeholder, never set in v1
        assertThat(loaded.getNthWeekday()).isNull(); // 3b placeholder, never set in v1
        assertThat(loaded.getRruleRaw()).isNull(); // extensibility seam, null in v1
        assertThat(loaded.getTimezone()).isEqualTo("Europe/London");
        assertThat(loaded.getUntilDate()).isEqualTo(LocalDate.now().plusMonths(2));
        assertThat(loaded.getOccurrenceCount()).isEqualTo(8);
        assertThat(loaded.getTemplateHeading()).isEqualTo("Weekly Round-Trip TM789");
        assertThat(loaded.getTemplateCapacity()).isEqualTo(30);
        assertThat(loaded.getTemplatePricePence()).isEqualTo(700);
        assertThat(loaded.isTemplatePremium()).isTrue();
        assertThat(loaded.getTemplateCity()).isEqualTo("London");
        assertThat(loaded.getTemplateBookingCutoffHours()).isEqualTo(2);
        assertThat(loaded.getStatus()).isEqualTo(SeriesStatus.ACTIVE);
        assertThat(loaded.getCreatedAt()).isNotNull(); // DB-authoritative DEFAULT now()
        assertThat(loaded.isDeleted()).isFalse();
    }

    /**
     * The house {@code @SQLRestriction("deleted_at is null")} hides a tombstoned series from every
     * normal query — {@code findById} returns empty for a soft-deleted series.
     */
    @Test
    void softDeletedSeriesIsHiddenFromNormalQueries() {
        EventSeries saved = series.saveAndFlush(newWeeklySeries("Soft-Delete Probe TM789"));
        jdbc.update("update event_series set deleted_at = now() where id = ?", saved.getId());

        assertThat(series.findById(saved.getId())).isEmpty();
    }

    /**
     * {@link EventSeriesRepository#findByIdIncludingDeleted} — the SOLE admin-only exception to the
     * {@code @SQLRestriction}: it must RETURN a soft-deleted series that {@code findById} hides. This
     * is the property the recurring-series clone (3b) relies on to duplicate a retired template.
     */
    @Test
    void findByIdIncludingDeletedReturnsASoftDeletedSeries() {
        EventSeries saved = series.saveAndFlush(newWeeklySeries("Include-Deleted Probe TM789"));
        Long id = saved.getId();
        jdbc.update("update event_series set deleted_at = now() where id = ?", id);

        // The restricted query hides it...
        assertThat(series.findById(id)).isEmpty();
        // ...but the admin-only bypass returns it, with its fields intact.
        EventSeries recovered = series.findByIdIncludingDeleted(id).orElseThrow();
        assertThat(recovered.getId()).isEqualTo(id);
        assertThat(recovered.getTemplateHeading()).isEqualTo("Include-Deleted Probe TM789");
        assertThat(recovered.isDeleted()).isTrue();
    }

    /** The three new events columns (series_id, occurrence_index, series_detached) round-trip on an Event. */
    @Test
    void eventSeriesReferenceColumnsRoundTrip() {
        EventSeries s = series.saveAndFlush(newWeeklySeries("Occurrence Parent TM789"));

        Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
        Event occurrence = new Event(
                "Occurrence #0 TM789",
                "Generated from the series.",
                "Marhaba Cafe, 12 High St",
                "Europe/London",
                now.plus(Duration.ofDays(3)),
                now,
                now.plus(Duration.ofDays(10)),
                creatorId,
                now);
        occurrence.setSeriesId(s.getId());
        occurrence.setOccurrenceIndex(0);
        Event savedOccurrence = events.saveAndFlush(occurrence);

        Event loaded = events.findById(savedOccurrence.getId()).orElseThrow();
        assertThat(loaded.getSeriesId()).isEqualTo(s.getId());
        assertThat(loaded.getOccurrenceIndex()).isEqualTo(0);
        assertThat(loaded.isSeriesDetached()).isFalse(); // DEFAULT false

        // And a one-off event created directly keeps series_id NULL (back-compat).
        Event oneOff = new Event(
                "One-off Control TM789",
                "Not part of a series.",
                "Somewhere",
                "Europe/London",
                now.plus(Duration.ofDays(4)),
                now,
                now.plus(Duration.ofDays(10)),
                creatorId,
                now);
        Event savedOneOff = events.saveAndFlush(oneOff);
        Event loadedOneOff = events.findById(savedOneOff.getId()).orElseThrow();
        assertThat(loadedOneOff.getSeriesId()).isNull();
        assertThat(loadedOneOff.getOccurrenceIndex()).isNull();
        assertThat(loadedOneOff.isSeriesDetached()).isFalse();
    }
}
