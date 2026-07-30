package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.JsonPath;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditEvent;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.event.EventStatus;
import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The create-series admin API (TM-795) end-to-end through the real security chain + Postgres — the
 * REST wrapper over {@link com.teammarhaba.backend.event.EventAdminService#createSeries createSeries}
 * (TM-791). Fail-before / pass-after gate: on origin/main the {@code POST /api/v1/admin/events/series}
 * endpoint, the {@code CreateSeriesRequest} DTO and the {@code CreateSeriesResponse} do not exist, so
 * this class does not compile (RED); with them wired it goes GREEN.
 *
 * <p>Covers the full acceptance contract:
 *
 * <ul>
 *   <li><b>Happy path</b> — ADMIN creates a series + its occurrences; 201 carries the series summary
 *       and the generated occurrence projections, and the occurrences are real PUBLISHED events.</li>
 *   <li><b>RBAC</b> — non-admin → uniform 403 (no series created).</li>
 *   <li><b>Edge validation (RFC-7807 400)</b> — two end conditions, zero end conditions, interval 0, a
 *       monthly frequency, a non-IANA timezone, a past start, an inverted first-occurrence window, and a
 *       WEEKLY byWeekday that doesn't match the anchor.</li>
 * </ul>
 *
 * <p>The suite shares one Postgres across classes, so assertions scope to this class's own rows
 * (unique headings / creator uids).
 */
@AutoConfigureMockMvc
class EventAdminCreateSeriesControllerIntegrationTest extends AbstractIntegrationTest {

    private static final ZoneId LONDON = ZoneId.of("Europe/London");

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private EventRepository events;

    @Autowired
    private AuditService audit;

    private static RequestPostProcessor admin(String uid) {
        return principal(uid, "ROLE_ADMIN");
    }

    private static RequestPostProcessor regularUser(String uid) {
        return principal(uid, "ROLE_USER");
    }

    private static RequestPostProcessor principal(String uid, String authority) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of(new SimpleGrantedAuthority(authority))));
    }

    /** An instant a few days out, on the given weekday, at 18:00 London — a valid future WEEKLY anchor. */
    private static Instant nextWeekdayAt(DayOfWeek weekday, int hour) {
        ZonedDateTime cursor = ZonedDateTime.now(LONDON)
                .plusDays(3)
                .withHour(hour)
                .withMinute(0)
                .withSecond(0)
                .withNano(0);
        while (cursor.getDayOfWeek() != weekday) {
            cursor = cursor.plusDays(1);
        }
        return cursor.toInstant();
    }

    /** A future anchor at 18:00 London, three days out (no weekday constraint — for DAILY). */
    private static Instant futureAnchor() {
        return ZonedDateTime.now(LONDON)
                .plusDays(3)
                .withHour(18)
                .withMinute(0)
                .withSecond(0)
                .withNano(0)
                .toInstant();
    }

    /**
     * A valid DAILY-every-2-days, afterN=4 body with a heading unique to this call, so parallel classes
     * sharing the DB don't collide. The first-occurrence window opens 5 days before start and closes 3h
     * after start (a 2h event), exactly as the TM-791 service test uses.
     */
    private static String dailyBody(String heading) {
        Instant start = futureAnchor();
        return String.format(
                """
                {
                  "frequency": "DAILY",
                  "interval": 2,
                  "afterN": 4,
                  "timezone": "Europe/London",
                  "firstStartAt": "%s",
                  "firstEndAt": "%s",
                  "firstVisibilityStart": "%s",
                  "firstVisibilityEnd": "%s",
                  "heading": "%s",
                  "description": "A recurring daily standup.",
                  "locationText": "Marhaba Cafe, 12 High St",
                  "city": "London",
                  "capacity": 25,
                  "pricePence": 700
                }
                """,
                start,
                start.plus(Duration.ofHours(2)),
                start.minus(Duration.ofDays(5)),
                start.plus(Duration.ofHours(3)),
                heading);
    }

    private List<AuditAction> seriesAuditActionsFor(long seriesId) {
        return audit.search(null, "EventSeries", String.valueOf(seriesId), PageRequest.of(0, 20)).getContent().stream()
                .map(AuditEvent::getAction)
                .toList();
    }

    // --- Happy path ---

    @Test
    void adminCreatesSeriesWithOccurrences() throws Exception {
        String heading = "Daily Standup " + UUID.randomUUID();
        String response = mockMvc.perform(post("/api/v1/admin/events/series")
                        .with(admin("series-admin-create"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(dailyBody(heading)))
                .andExpect(status().isCreated())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.id").isNumber())
                .andExpect(jsonPath("$.frequency").value("DAILY"))
                .andExpect(jsonPath("$.interval").value(2))
                .andExpect(jsonPath("$.occurrenceCount").value(4))
                .andExpect(jsonPath("$.status").value("ACTIVE"))
                .andExpect(jsonPath("$.heading").value(heading))
                .andExpect(jsonPath("$.timezone").value("Europe/London"))
                .andExpect(jsonPath("$.createdAt").isNotEmpty())
                .andExpect(jsonPath("$.createdBy").isNumber())
                // afterN=4 → exactly 4 occurrences materialised (well inside the 90-day / 12 caps)
                .andExpect(jsonPath("$.occurrenceBatchSize").value(4))
                .andExpect(jsonPath("$.occurrences.length()").value(4))
                // each occurrence is an ordinary PUBLISHED event carrying the template fields
                .andExpect(jsonPath("$.occurrences[0].status").value("PUBLISHED"))
                .andExpect(jsonPath("$.occurrences[0].heading").value(heading))
                .andExpect(jsonPath("$.occurrences[0].capacity").value(25))
                .andExpect(jsonPath("$.occurrences[0].pricePence").value(700))
                .andReturn()
                .getResponse()
                .getContentAsString();

        long seriesId = JsonPath.parse(response).<Number>read("$.id").longValue();
        // the occurrences are persisted, linked to the series, indexed 0..3 in order
        List<Event> occurrences = events.findBySeriesIdOrderByOccurrenceIndexAsc(seriesId);
        assertThat(occurrences).hasSize(4);
        assertThat(occurrences).allSatisfy(e -> {
            assertThat(e.getSeriesId()).isEqualTo(seriesId);
            assertThat(e.getStatus()).isEqualTo(EventStatus.PUBLISHED);
            assertThat(e.getHeading()).isEqualTo(heading);
        });
        assertThat(occurrences.stream().map(Event::getOccurrenceIndex).toList()).containsExactly(0, 1, 2, 3);
        // the series creation is audited (house pattern)
        assertThat(seriesAuditActionsFor(seriesId)).contains(AuditAction.SERIES_CREATED);
    }

    @Test
    void weeklyOnASpecificWeekdayIsAccepted() throws Exception {
        Instant start = nextWeekdayAt(DayOfWeek.TUESDAY, 19);
        String heading = "Tuesday Circle " + UUID.randomUUID();
        String body = String.format(
                """
                {
                  "frequency": "WEEKLY",
                  "interval": 1,
                  "byWeekday": "TUESDAY",
                  "untilDate": "%s",
                  "timezone": "Europe/London",
                  "firstStartAt": "%s",
                  "firstEndAt": "%s",
                  "firstVisibilityStart": "%s",
                  "firstVisibilityEnd": "%s",
                  "heading": "%s",
                  "description": "A weekly circle.",
                  "locationText": "Community Hall"
                }
                """,
                start.atZone(LONDON).toLocalDate().plusWeeks(3),
                start,
                start.plus(Duration.ofHours(2)),
                start.minus(Duration.ofDays(2)),
                start.plus(Duration.ofHours(3)),
                heading);

        mockMvc.perform(post("/api/v1/admin/events/series")
                        .with(admin("series-admin-weekly"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.frequency").value("WEEKLY"))
                .andExpect(jsonPath("$.byWeekday").value(DayOfWeek.TUESDAY.getValue()))
                .andExpect(jsonPath("$.occurrences.length()").value(org.hamcrest.Matchers.greaterThan(0)));
    }

    // --- RBAC ---

    @Test
    void nonAdminCannotCreateSeries() throws Exception {
        mockMvc.perform(post("/api/v1/admin/events/series")
                        .with(regularUser("series-plain-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(dailyBody("Should not be created " + UUID.randomUUID())))
                .andExpect(status().isForbidden())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Forbidden"))
                .andExpect(jsonPath("$.status").value(403));
    }

    // --- Edge validation (RFC-7807 400) ---

    @Test
    void rejectsTwoEndConditions() throws Exception {
        // afterN AND untilDate together — ambiguous, exactly-one rule fires.
        Instant start = futureAnchor();
        String body = dailyBody("Two ends " + UUID.randomUUID())
                .replace("\"afterN\": 4,", "\"afterN\": 4,\n  \"untilDate\": \""
                        + start.atZone(LONDON).toLocalDate().plusDays(10) + "\",");
        mockMvc.perform(post("/api/v1/admin/events/series")
                        .with(admin("series-admin-2ends"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));
    }

    @Test
    void rejectsZeroEndConditions() throws Exception {
        // neither afterN nor untilDate — exactly-one rule fires.
        String body = dailyBody("No ends " + UUID.randomUUID()).replace("\"afterN\": 4,", "");
        mockMvc.perform(post("/api/v1/admin/events/series")
                        .with(admin("series-admin-0ends"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));
    }

    @Test
    void rejectsZeroInterval() throws Exception {
        String body = dailyBody("Zero interval " + UUID.randomUUID()).replace("\"interval\": 2,", "\"interval\": 0,");
        mockMvc.perform(post("/api/v1/admin/events/series")
                        .with(admin("series-admin-interval"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[?(@.field == 'interval')]").exists());
    }

    @Test
    void rejectsMonthlyFrequency() throws Exception {
        // MONTHLY is not on the SeriesFrequency enum (v1 thin cut) → clean 400 at JSON binding.
        String body = dailyBody("Monthly " + UUID.randomUUID()).replace("\"frequency\": \"DAILY\"", "\"frequency\": \"MONTHLY\"");
        mockMvc.perform(post("/api/v1/admin/events/series")
                        .with(admin("series-admin-monthly"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest());
    }

    @Test
    void rejectsNonIanaTimezone() throws Exception {
        String body = dailyBody("Bad tz " + UUID.randomUUID()).replace("Europe/London", "Mars/Olympus_Mons");
        mockMvc.perform(post("/api/v1/admin/events/series")
                        .with(admin("series-admin-tz"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));
    }

    @Test
    void rejectsPastStart() throws Exception {
        // A firstStartAt in the past — nothing left to schedule.
        Instant past = Instant.now().minus(Duration.ofDays(2));
        String body = String.format(
                """
                {
                  "frequency": "DAILY",
                  "interval": 1,
                  "afterN": 3,
                  "timezone": "Europe/London",
                  "firstStartAt": "%s",
                  "firstEndAt": "%s",
                  "firstVisibilityStart": "%s",
                  "firstVisibilityEnd": "%s",
                  "heading": "Past start %s",
                  "description": "Already gone.",
                  "locationText": "Nowhere"
                }
                """,
                past,
                past.plus(Duration.ofHours(1)),
                past.minus(Duration.ofDays(1)),
                past.plus(Duration.ofHours(2)),
                UUID.randomUUID());
        mockMvc.perform(post("/api/v1/admin/events/series")
                        .with(admin("series-admin-past"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));
    }

    @Test
    void rejectsInvertedFirstOccurrenceWindow() throws Exception {
        // firstVisibilityStart AFTER firstStartAt — the window no longer brackets the start.
        Instant start = futureAnchor();
        String body = String.format(
                """
                {
                  "frequency": "DAILY",
                  "interval": 1,
                  "afterN": 3,
                  "timezone": "Europe/London",
                  "firstStartAt": "%s",
                  "firstEndAt": "%s",
                  "firstVisibilityStart": "%s",
                  "firstVisibilityEnd": "%s",
                  "heading": "Bad window %s",
                  "description": "Window inverted.",
                  "locationText": "Somewhere"
                }
                """,
                start,
                start.plus(Duration.ofHours(2)),
                start.plus(Duration.ofHours(1)), // visibilityStart AFTER start — invalid
                start.plus(Duration.ofHours(3)),
                UUID.randomUUID());
        mockMvc.perform(post("/api/v1/admin/events/series")
                        .with(admin("series-admin-window"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));
    }

    @Test
    void rejectsWeeklyWeekdayNotMatchingAnchor() throws Exception {
        // Anchor is a Tuesday but byWeekday says WEDNESDAY — the engine would refuse to realign; caught
        // at the edge as a clean 400 (not a 500).
        Instant tuesday = nextWeekdayAt(DayOfWeek.TUESDAY, 19);
        String body = String.format(
                """
                {
                  "frequency": "WEEKLY",
                  "interval": 1,
                  "byWeekday": "WEDNESDAY",
                  "afterN": 3,
                  "timezone": "Europe/London",
                  "firstStartAt": "%s",
                  "firstEndAt": "%s",
                  "firstVisibilityStart": "%s",
                  "firstVisibilityEnd": "%s",
                  "heading": "Weekday mismatch %s",
                  "description": "Wrong weekday.",
                  "locationText": "Hall"
                }
                """,
                tuesday,
                tuesday.plus(Duration.ofHours(2)),
                tuesday.minus(Duration.ofDays(1)),
                tuesday.plus(Duration.ofHours(3)),
                UUID.randomUUID());
        mockMvc.perform(post("/api/v1/admin/events/series")
                        .with(admin("series-admin-weekday-mismatch"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));
    }

    @Test
    void rejectsWeeklyWithoutByWeekday() throws Exception {
        Instant start = futureAnchor();
        String body = String.format(
                """
                {
                  "frequency": "WEEKLY",
                  "interval": 1,
                  "afterN": 3,
                  "timezone": "Europe/London",
                  "firstStartAt": "%s",
                  "firstEndAt": "%s",
                  "firstVisibilityStart": "%s",
                  "firstVisibilityEnd": "%s",
                  "heading": "Weekly no weekday %s",
                  "description": "Missing weekday.",
                  "locationText": "Hall"
                }
                """,
                start,
                start.plus(Duration.ofHours(2)),
                start.minus(Duration.ofDays(1)),
                start.plus(Duration.ofHours(3)),
                UUID.randomUUID());
        mockMvc.perform(post("/api/v1/admin/events/series")
                        .with(admin("series-admin-weekly-noweekday"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));
    }
}
