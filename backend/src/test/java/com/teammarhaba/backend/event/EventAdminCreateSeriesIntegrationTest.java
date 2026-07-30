package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Wires the series model (TM-789) to the occurrence engine (TM-790) through
 * {@link EventAdminService#createSeries} (TM-791): a recurring series is persisted and its first
 * in-horizon batch of real {@link Event} occurrences is materialised. This is the fail-before /
 * pass-after gate for TM-791 — on origin/main the method is absent, so this class does not compile
 * (RED); with the method it goes GREEN.
 *
 * <p>The tests assert the whole contract: the series row (ACTIVE, template, horizon watermark), the
 * generated occurrences (count / dates / zero-based indices / series linkage / template fields), the
 * weekly-weekday + daily-interval + until/afterN end conditions, and — crucially — that each
 * occurrence is a normal event by RSVPing one of them through the ordinary
 * {@link EventRsvpService#rsvp} path.
 *
 * <p>The suite shares one Postgres across classes, so assertions scope to this class's own rows
 * (unique series id / unique creator).
 */
class EventAdminCreateSeriesIntegrationTest extends AbstractIntegrationTest {

    private static final ZoneId LONDON = ZoneId.of("Europe/London");

    @Autowired
    private EventAdminService admin;

    @Autowired
    private EventRsvpService rsvps;

    @Autowired
    private EventSeriesRepository series;

    @Autowired
    private EventAttendanceRepository attendance;

    @Autowired
    private UserRepository users;

    @Autowired
    private JdbcTemplate jdbc;

    /**
     * DAILY, every 2 days, capped afterN=4: exactly 4 occurrences at the anchor + 2/4/6 days, each a
     * PUBLISHED event carrying its zero-based occurrence_index, the series id, and the template fields;
     * the visibility window + duration derive from the first-occurrence offsets, per occurrence.
     */
    @Test
    void dailyEveryTwoDaysAfterFour_generatesFourLinkedOccurrences() {
        VerifiedUser caller = newCaller("daily");
        // Anchor a few days out so every occurrence is in the future (well inside the 90-day horizon).
        Instant firstStart = ZonedDateTime.now(LONDON)
                .plusDays(3)
                .withHour(18)
                .withMinute(0)
                .withSecond(0)
                .withNano(0)
                .toInstant();

        SeriesDraft draft = new SeriesDraft(
                SeriesFrequency.DAILY,
                2,
                null, // byWeekday — null for DAILY
                null, // untilDate
                4, // afterN
                "Europe/London",
                firstStart,
                firstStart.plus(Duration.ofHours(2)), // firstEndAt (2h duration)
                // Opens 5 days before start: for occurrence #0 (start +3d) that is 2 days ago, so #0 is
                // visible NOW and RSVP-able below. The offset is what each later occurrence inherits.
                firstStart.minus(Duration.ofDays(5)), // firstVisibilityStart
                firstStart.plus(Duration.ofHours(3)), // firstVisibilityEnd (closes 1h after end)
                "Daily Standup " + UUID.randomUUID(),
                "A recurring daily standup.",
                "Marhaba Cafe, 12 High St",
                "London", // city
                null, // venueId
                25, // capacity
                null, // imagePath
                null, // locationRevealHours
                null, // bookingCutoffHours
                null, // cancellationWindowHours
                700, // pricePence
                null); // premium

        EventSeries saved = admin.createSeries(caller, draft);

        // --- series row ---
        assertThat(saved.getId()).isNotNull();
        assertThat(saved.getStatus()).isEqualTo(SeriesStatus.ACTIVE);
        assertThat(saved.getFrequency()).isEqualTo(SeriesFrequency.DAILY);
        assertThat(saved.getInterval()).isEqualTo(2);
        assertThat(saved.getByWeekday()).isNull();
        assertThat(saved.getOccurrenceCount()).isEqualTo(4);
        assertThat(saved.getTemplateCapacity()).isEqualTo(25);
        assertThat(saved.getTemplatePricePence()).isEqualTo(700);
        assertThat(saved.getCreatedAt()).isNotNull(); // DB-authoritative DEFAULT now()
        // Horizon watermark = the last generated start.
        assertThat(saved.getHorizonGeneratedUntil()).isEqualTo(firstStart.plus(Duration.ofDays(6)));

        // --- occurrences ---
        List<Event> occurrences = occurrencesOf(saved.getId());
        assertThat(occurrences).hasSize(4);
        // Zero-based, contiguous indices in order.
        assertThat(occurrences).extracting(Event::getOccurrenceIndex).containsExactly(0, 1, 2, 3);
        // DAILY every-2-days steps: anchor, +2, +4, +6 days.
        assertThat(occurrences).extracting(Event::getStartAt)
                .containsExactly(
                        firstStart,
                        firstStart.plus(Duration.ofDays(2)),
                        firstStart.plus(Duration.ofDays(4)),
                        firstStart.plus(Duration.ofDays(6)));

        Event first = occurrences.get(0);
        assertThat(first.getSeriesId()).isEqualTo(saved.getId());
        assertThat(first.isSeriesDetached()).isFalse();
        assertThat(first.getStatus()).isEqualTo(EventStatus.PUBLISHED);
        assertThat(first.getHeading()).isEqualTo(draft.heading());
        assertThat(first.getLocationText()).isEqualTo("Marhaba Cafe, 12 High St");
        assertThat(first.getCity()).isEqualTo("London");
        assertThat(first.getCapacity()).isEqualTo(25);
        assertThat(first.getPricePence()).isEqualTo(700);
        // Window derivation replays the first-occurrence offsets on each start.
        assertThat(first.getEndAt()).isEqualTo(firstStart.plus(Duration.ofHours(2)));
        assertThat(first.getVisibilityStart()).isEqualTo(firstStart.minus(Duration.ofDays(5)));
        assertThat(first.getVisibilityEnd()).isEqualTo(firstStart.plus(Duration.ofHours(3)));

        // A later occurrence keeps the same duration + visibility lead/lag relative to ITS own start.
        Event third = occurrences.get(2);
        Instant thirdStart = firstStart.plus(Duration.ofDays(4));
        assertThat(third.getEndAt()).isEqualTo(thirdStart.plus(Duration.ofHours(2)));
        assertThat(third.getVisibilityStart()).isEqualTo(thirdStart.minus(Duration.ofDays(5)));
        assertThat(third.getVisibilityEnd()).isEqualTo(thirdStart.plus(Duration.ofHours(3)));

        // --- each occurrence is a normal, independently RSVP-able event ---
        // Occurrence #0 is visible now (its window opened 2 days ago), so RSVP lands GOING through the
        // ordinary user path — proving the generated occurrence is a fully normal, RSVP-able event.
        RsvpResult rsvp = rsvps.rsvp(caller, first.getId());
        assertThat(rsvp.state()).isEqualTo(AttendanceState.GOING);
        assertThat(attendance.countByEventIdAndState(first.getId(), AttendanceState.GOING))
                .isEqualTo(1);
    }

    /**
     * WEEKLY on Wednesday, every week, until a fixed date: occurrences land on Wednesdays only, step by
     * 7 days, and stop at (inclusive) the until-date.
     */
    @Test
    void weeklyOnWednesdayUntilDate_picksWednesdaysAndHonoursTheEnd() {
        VerifiedUser caller = newCaller("weekly");
        // First Wednesday strictly in the future, at 19:00 London.
        LocalDate today = LocalDate.now(LONDON);
        LocalDate firstWed = today.plusDays(1);
        while (firstWed.getDayOfWeek() != DayOfWeek.WEDNESDAY) {
            firstWed = firstWed.plusDays(1);
        }
        Instant firstStart =
                ZonedDateTime.of(firstWed, java.time.LocalTime.of(19, 0), LONDON).toInstant();
        // Until the 3rd Wednesday (inclusive) → exactly 3 occurrences.
        LocalDate until = firstWed.plusWeeks(2);

        SeriesDraft draft = new SeriesDraft(
                SeriesFrequency.WEEKLY,
                1,
                DayOfWeek.WEDNESDAY,
                until, // untilDate
                null, // afterN
                "Europe/London",
                firstStart,
                firstStart.plus(Duration.ofHours(2)),
                firstStart.minus(Duration.ofDays(2)),
                firstStart.plus(Duration.ofHours(2)),
                "Weekly Circle " + UUID.randomUUID(),
                "A recurring weekly circle.",
                "Marhaba Cafe",
                null, // city
                null, // venueId
                null, // capacity (unlimited)
                null, // imagePath
                null,
                null,
                null,
                null, // pricePence → template default (£5)
                null);

        EventSeries saved = admin.createSeries(caller, draft);

        assertThat(saved.getFrequency()).isEqualTo(SeriesFrequency.WEEKLY);
        assertThat(saved.getByWeekday()).isEqualTo(DayOfWeek.WEDNESDAY.getValue()); // 3
        assertThat(saved.getUntilDate()).isEqualTo(until);
        assertThat(saved.getTemplatePricePence()).isEqualTo(Event.DEFAULT_PRICE_PENCE); // untouched default

        List<Event> occurrences = occurrencesOf(saved.getId());
        assertThat(occurrences).hasSize(3);
        assertThat(occurrences).extracting(Event::getOccurrenceIndex).containsExactly(0, 1, 2);
        // 7-day steps, all on the anchor's weekday.
        assertThat(occurrences).extracting(Event::getStartAt)
                .containsExactly(
                        firstStart, firstStart.plus(Duration.ofDays(7)), firstStart.plus(Duration.ofDays(14)));
        // Every occurrence is a Wednesday in London.
        assertThat(occurrences)
                .allSatisfy(e -> assertThat(e.getStartAt().atZone(LONDON).getDayOfWeek())
                        .isEqualTo(DayOfWeek.WEDNESDAY));
        assertThat(occurrences).allSatisfy(e -> {
            assertThat(e.getSeriesId()).isEqualTo(saved.getId());
            assertThat(e.getStatus()).isEqualTo(EventStatus.PUBLISHED);
            assertThat(e.getCapacity()).isNull(); // unlimited
        });
    }

    // ------------------------------------------------------------------ fixtures

    /**
     * Occurrences of a series, ordered by occurrence_index. The id order comes from a scoped SQL query
     * (series_id filter — there is no repository finder in v1); each row is then loaded as a managed
     * {@link Event} so entity getters (and the {@code @SQLRestriction}) apply.
     */
    private List<Event> occurrencesOf(Long seriesId) {
        List<Long> ids = jdbc.queryForList(
                "select id from events where series_id = ? order by occurrence_index", Long.class, seriesId);
        return ids.stream().map(id -> eventRepo.findById(id).orElseThrow()).toList();
    }

    @Autowired
    private EventRepository eventRepo;

    private VerifiedUser newCaller(String tag) {
        String uid = "uid-series-" + tag + "-" + UUID.randomUUID();
        User user = users.save(new User(uid, tag + "-" + UUID.randomUUID() + "@example.com", tag));
        return new VerifiedUser(user.getFirebaseUid(), user.getEmail());
    }
}
