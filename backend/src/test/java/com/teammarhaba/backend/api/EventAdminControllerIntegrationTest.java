package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
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
import com.teammarhaba.backend.event.AttendanceState;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventAttendance;
import com.teammarhaba.backend.event.EventAttendanceRepository;
import com.teammarhaba.backend.event.EventLifecycleEvent;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.event.EventStatus;
import com.teammarhaba.backend.event.Venue;
import com.teammarhaba.backend.event.VenueRepository;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.context.event.ApplicationEvents;
import org.springframework.test.context.event.RecordApplicationEvents;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The admin events API (TM-392) end-to-end through the real security chain + Postgres:
 *
 * <ul>
 *   <li><b>RBAC, the TM-111 pattern</b> — anon → uniform 401, USER → uniform 403, and a missing id
 *       → plain 404 (no existence leak).</li>
 *   <li><b>Validation</b> — heading ≤ 120 / description ≤ 5000 (the V12 column cap), capacity ≥ 1,
 *       ordered visibility window (request-level AND merged-state on PATCH), real IANA timezone,
 *       storage-path-shaped image path.</li>
 *   <li><b>Cancel semantics</b> — the record survives with status CANCELLED, cancel is idempotent
 *       and never double-audits/double-signals.</li>
 *   <li><b>Admin listing</b> — includes not-yet-visible and cancelled events (full inventory).</li>
 *   <li><b>TM-397 seam</b> — create/edit/cancel publish {@link EventLifecycleEvent}; a no-op edit
 *       does not (recorded via {@link RecordApplicationEvents}).</li>
 * </ul>
 *
 * <p>The suite shares one database across test classes, so assertions use contains/filtering on
 * this class's own rows rather than exact table contents.
 */
@AutoConfigureMockMvc
@RecordApplicationEvents
class EventAdminControllerIntegrationTest extends AbstractIntegrationTest {

    private static final String VALID_BODY =
            """
            {
              "heading": "Marhaba picnic",
              "description": "Bring a dish to share.",
              "locationText": "Victoria Park, main gate",
              "timezone": "Europe/London",
              "startAt": "2030-06-15T12:00:00Z",
              "endAt": "2030-06-15T15:00:00Z",
              "visibilityStart": "2030-05-01T00:00:00Z",
              "visibilityEnd": "2030-06-16T00:00:00Z",
              "capacity": 40
            }
            """;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private EventRepository events;

    @Autowired
    private UserRepository users;

    @Autowired
    private AuditService audit;

    @Autowired
    private ApplicationEvents applicationEvents;

    @Autowired
    private EventAttendanceRepository attendance;

    @Autowired
    private VenueRepository venues;

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

    /** Seed an event directly through the repository (needs a creator row for the FK). */
    private Event seedEvent(String heading, Instant visibilityStart, Instant visibilityEnd) {
        Long creatorId = users.findByFirebaseUid("event-admin-seed-uid")
                .orElseGet(() -> users.saveAndFlush(new User("event-admin-seed-uid", "seed@example.com", "Seeder")))
                .getId();
        Instant now = Instant.now();
        Event event = new Event(
                heading,
                "Seeded for the admin API tests.",
                "Marhaba Cafe, 12 High St",
                "Europe/London",
                visibilityEnd.plusSeconds(3600),
                visibilityStart,
                visibilityEnd,
                creatorId,
                now);
        return events.saveAndFlush(event);
    }

    /** Register a fresh user as attending an event in the given state (for the count assertions). */
    private void attend(long eventId, String uid, AttendanceState state) {
        Long userId = users.saveAndFlush(new User(uid, uid + "@example.com", uid)).getId();
        attendance.saveAndFlush(new EventAttendance(eventId, userId, state));
    }

    /** Seed a reusable venue for the event-reference wiring tests (TM-519). */
    private Venue seedVenue(String name, boolean active) {
        Long creatorId = users.findByFirebaseUid("event-admin-seed-uid")
                .orElseGet(() -> users.saveAndFlush(new User("event-admin-seed-uid", "seed@example.com", "Seeder")))
                .getId();
        Venue venue = new Venue(name, name + " address", creatorId, Instant.now());
        venue.setActive(active);
        return venues.saveAndFlush(venue);
    }

    private List<AuditAction> auditActionsFor(long eventId) {
        return audit.search(null, "Event", String.valueOf(eventId), PageRequest.of(0, 20)).getContent().stream()
                .map(AuditEvent::getAction)
                .toList();
    }

    private List<EventLifecycleEvent> lifecycleSignals(long eventId, EventLifecycleEvent.Kind kind) {
        return applicationEvents
                .stream(EventLifecycleEvent.class)
                .filter(signal -> signal.eventId() == eventId && signal.kind() == kind)
                .toList();
    }

    // --- RBAC: the TM-111 401/403/404 pattern ---

    @Test
    void anonymousGetsUniform401() throws Exception {
        mockMvc.perform(get("/api/v1/admin/events"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Unauthorized"));
    }

    @Test
    void nonAdminGetsUniform403() throws Exception {
        mockMvc.perform(get("/api/v1/admin/events").with(regularUser("events-plain-user")))
                .andExpect(status().isForbidden())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Forbidden"))
                .andExpect(jsonPath("$.status").value(403));
    }

    @Test
    void nonAdminCannotCreateOrCancel() throws Exception {
        mockMvc.perform(post("/api/v1/admin/events")
                        .with(regularUser("events-plain-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY))
                .andExpect(status().isForbidden());

        mockMvc.perform(post("/api/v1/admin/events/{id}/cancel", 1L).with(regularUser("events-plain-user")))
                .andExpect(status().isForbidden());
    }

    @Test
    void missingEventIs404NotLeaking() throws Exception {
        mockMvc.perform(get("/api/v1/admin/events/{id}", 999_999L).with(admin("events-admin-404")))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.title").value("Resource not found"));

        mockMvc.perform(patch("/api/v1/admin/events/{id}", 999_999L)
                        .with(admin("events-admin-404"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"heading\":\"New heading\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.title").value("Resource not found"));

        mockMvc.perform(post("/api/v1/admin/events/{id}/cancel", 999_999L).with(admin("events-admin-404")))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.title").value("Resource not found"));
    }

    // --- Create ---

    @Test
    void adminCreatesEventAuditedAndSignalled() throws Exception {
        String body = mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-create"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").isNumber())
                .andExpect(jsonPath("$.heading").value("Marhaba picnic"))
                .andExpect(jsonPath("$.status").value("PUBLISHED"))
                .andExpect(jsonPath("$.timezone").value("Europe/London"))
                .andExpect(jsonPath("$.capacity").value(40))
                // created_at is DB-authoritative; the 201 body must carry the real value, not null
                .andExpect(jsonPath("$.createdAt").isNotEmpty())
                .andExpect(jsonPath("$.createdBy").isNumber())
                .andReturn()
                .getResponse()
                .getContentAsString();
        long id = JsonPath.parse(body).<Number>read("$.id").longValue();

        Event saved = events.findById(id).orElseThrow();
        assertThat(saved.getHeading()).isEqualTo("Marhaba picnic");
        assertThat(saved.getStatus()).isEqualTo(EventStatus.PUBLISHED);
        // house audit pattern: the mutation and its audit row commit together
        assertThat(auditActionsFor(id)).contains(AuditAction.EVENT_CREATED);
        // the TM-397 seam saw the creation
        assertThat(lifecycleSignals(id, EventLifecycleEvent.Kind.CREATED)).hasSize(1);
    }

    // --- Price + premium (TM-475) ---

    @Test
    void createDefaultsPriceToFivePoundsAndNotPremium() throws Exception {
        // VALID_BODY names neither price nor premium: the create must fall back to the £5 (500p)
        // default and non-premium — the value the V21 column default also backfills.
        String body = mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-price-default"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.pricePence").value(500))
                .andExpect(jsonPath("$.premium").value(false))
                .andReturn()
                .getResponse()
                .getContentAsString();
        long id = JsonPath.parse(body).<Number>read("$.id").longValue();

        Event saved = events.findById(id).orElseThrow();
        assertThat(saved.getPricePence()).isEqualTo(500);
        assertThat(saved.isPremium()).isFalse();
    }

    @Test
    void createAcceptsExplicitPriceAndPremium() throws Exception {
        String body = VALID_BODY.replace("\"capacity\": 40", "\"capacity\": 40, \"pricePence\": 1500, \"premium\": true");
        String response = mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-price-set"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.pricePence").value(1500))
                .andExpect(jsonPath("$.premium").value(true))
                .andReturn()
                .getResponse()
                .getContentAsString();
        long id = JsonPath.parse(response).<Number>read("$.id").longValue();

        Event saved = events.findById(id).orElseThrow();
        assertThat(saved.getPricePence()).isEqualTo(1500);
        assertThat(saved.isPremium()).isTrue();
    }

    @Test
    void createAcceptsZeroPriceAsFree() throws Exception {
        // price >= 0, so 0 (a free event) is valid — the boundary just below the negative reject.
        mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-price-free"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace("\"capacity\": 40", "\"capacity\": 40, \"pricePence\": 0")))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.pricePence").value(0));
    }

    @Test
    void createRejectsNegativePrice() throws Exception {
        mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-price-neg"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace("\"capacity\": 40", "\"capacity\": 40, \"pricePence\": -1")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'pricePence')]").exists());
    }

    @Test
    void patchUpdatesPriceAndPremium() throws Exception {
        Event seeded = seedEvent("Reprice", Instant.parse("2030-01-01T00:00:00Z"), Instant.parse("2030-02-01T00:00:00Z"));
        long id = seeded.getId();

        mockMvc.perform(patch("/api/v1/admin/events/{id}", id)
                        .with(admin("events-admin-reprice"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"pricePence\":2500,\"premium\":true}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.pricePence").value(2500))
                .andExpect(jsonPath("$.premium").value(true));

        Event reloaded = events.findById(id).orElseThrow();
        assertThat(reloaded.getPricePence()).isEqualTo(2500);
        assertThat(reloaded.isPremium()).isTrue();
        assertThat(auditActionsFor(id)).contains(AuditAction.EVENT_UPDATED);
    }

    // --- Per-event booking-cutoff & cancellation-window overrides (TM-413/TM-414/TM-523) ---
    //
    // These are the regression tests for TM-523: before the fix the two override columns (V16/V17)
    // could never be set — CreateEventRequest/UpdateEventRequest/EventResponse didn't carry the
    // fields — so BookingCutoffPolicy/CancellationPolicy always fell through to the app defaults and
    // the columns stayed permanently NULL. The set-path tests fail on the old code (the fields don't
    // round-trip and the columns stay null); they pass once the fields are wired end-to-end.

    @Test
    void createHonoursPerEventCutoffAndCancellationOverrides() throws Exception {
        // A create naming explicit overrides (6h cutoff, 48h cancellation window) must persist them and
        // the policies must RESOLVE those values — proven by the effective* fields, which are computed
        // by the real BookingCutoffPolicy / CancellationPolicy beans, not the raw override echoed back.
        String body = VALID_BODY.replace(
                "\"capacity\": 40", "\"capacity\": 40, \"bookingCutoffHours\": 6, \"cancellationWindowHours\": 48");
        String response = mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-cutoff-set"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated())
                // the raw per-event overrides round-trip in the response
                .andExpect(jsonPath("$.bookingCutoffHours").value(6))
                .andExpect(jsonPath("$.cancellationWindowHours").value(48))
                // ...and the policies HONOUR them: the effective window is the override, not the 1h/24h
                // app default it would fall back to if the override were unreachable (the old bug).
                .andExpect(jsonPath("$.effectiveBookingCutoffHours").value(6))
                .andExpect(jsonPath("$.effectiveCancellationWindowHours").value(48))
                .andReturn()
                .getResponse()
                .getContentAsString();
        long id = JsonPath.parse(response).<Number>read("$.id").longValue();

        // the previously-unreachable V16/V17 columns now carry the override
        Event saved = events.findById(id).orElseThrow();
        assertThat(saved.getBookingCutoffHours()).isEqualTo(6);
        assertThat(saved.getCancellationWindowHours()).isEqualTo(48);
    }

    @Test
    void createLeavesCutoffAndCancellationUnsetSoTheyInheritTheAppDefaults() throws Exception {
        // The default-fallback case: VALID_BODY names neither override, so the columns stay NULL
        // (inherit) and the policies resolve to the shipped app defaults — 1h booking cutoff, 24h
        // cancellation window. This proves "fall back to city/app default only when unset".
        String response = mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-cutoff-default"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY))
                .andExpect(status().isCreated())
                // no override supplied → the raw fields come back null (inherit)
                .andExpect(jsonPath("$.bookingCutoffHours").value(org.hamcrest.Matchers.nullValue()))
                .andExpect(jsonPath("$.cancellationWindowHours").value(org.hamcrest.Matchers.nullValue()))
                // ...and the effective window is the app default, not a per-event value
                .andExpect(jsonPath("$.effectiveBookingCutoffHours").value(1))
                .andExpect(jsonPath("$.effectiveCancellationWindowHours").value(24))
                .andReturn()
                .getResponse()
                .getContentAsString();
        long id = JsonPath.parse(response).<Number>read("$.id").longValue();

        // columns stay NULL — the inherit signal the policies fall through on
        Event saved = events.findById(id).orElseThrow();
        assertThat(saved.getBookingCutoffHours()).isNull();
        assertThat(saved.getCancellationWindowHours()).isNull();
    }

    @Test
    void createHonoursAnExplicitZeroCutoffOverride() throws Exception {
        // A meaningful 0h override ("bookable right up to the start") is distinct from null/inherit and
        // must NOT be swallowed as "unset" — the @Min(0) bound admits it and the policy resolves 0.
        String response = mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-cutoff-zero"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace("\"capacity\": 40", "\"capacity\": 40, \"bookingCutoffHours\": 0")))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.bookingCutoffHours").value(0))
                .andExpect(jsonPath("$.effectiveBookingCutoffHours").value(0))
                .andReturn()
                .getResponse()
                .getContentAsString();
        long id = JsonPath.parse(response).<Number>read("$.id").longValue();
        assertThat(events.findById(id).orElseThrow().getBookingCutoffHours()).isZero();
    }

    @Test
    void patchUpdatesCutoffAndCancellationOverrides() throws Exception {
        Event seeded =
                seedEvent("Retune", Instant.parse("2030-01-01T00:00:00Z"), Instant.parse("2030-02-01T00:00:00Z"));
        long id = seeded.getId();
        // seeded via the constructor with no overrides → starts at inherit (null)
        assertThat(seeded.getBookingCutoffHours()).isNull();
        assertThat(seeded.getCancellationWindowHours()).isNull();

        mockMvc.perform(patch("/api/v1/admin/events/{id}", id)
                        .with(admin("events-admin-cutoff-patch"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"bookingCutoffHours\":3,\"cancellationWindowHours\":12}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.bookingCutoffHours").value(3))
                .andExpect(jsonPath("$.cancellationWindowHours").value(12))
                .andExpect(jsonPath("$.effectiveBookingCutoffHours").value(3))
                .andExpect(jsonPath("$.effectiveCancellationWindowHours").value(12));

        Event reloaded = events.findById(id).orElseThrow();
        assertThat(reloaded.getBookingCutoffHours()).isEqualTo(3);
        assertThat(reloaded.getCancellationWindowHours()).isEqualTo(12);
        assertThat(auditActionsFor(id)).contains(AuditAction.EVENT_UPDATED);
    }

    @Test
    void createRejectsCutoffOverrideAboveTheYearCap() throws Exception {
        // 8760h (a year) is the accepted ceiling; 8761 is rejected at the request edge, RFC-7807.
        mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-cutoff-max"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace(
                                "\"capacity\": 40", "\"capacity\": 40, \"bookingCutoffHours\": 8761")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'bookingCutoffHours')]").exists());
    }

    // --- Validation (bean validation at the edge, RFC-7807 body) ---

    @Test
    void createRejectsOversizeHeading() throws Exception {
        String oversize = VALID_BODY.replace("Marhaba picnic", "h".repeat(121));
        mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(oversize))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'heading')]").exists());
    }

    @Test
    void createAcceptsDescriptionAtTheCapAndRejectsAbove() throws Exception {
        // exactly 5000 chars: passes validation AND the V12-widened column
        mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace("Bring a dish to share.", "d".repeat(5000))))
                .andExpect(status().isCreated());

        mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace("Bring a dish to share.", "d".repeat(5001))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[?(@.field == 'description')]").exists());
    }

    @Test
    void createRejectsZeroCapacity() throws Exception {
        mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace("\"capacity\": 40", "\"capacity\": 0")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[?(@.field == 'capacity')]").exists());
    }

    @Test
    void createRejectsUnknownTimezone() throws Exception {
        mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace("Europe/London", "Mars/Olympus_Mons")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));
    }

    @Test
    void createRejectsInvertedVisibilityWindow() throws Exception {
        String inverted = VALID_BODY
                .replace("\"visibilityStart\": \"2030-05-01T00:00:00Z\"", "\"visibilityStart\": \"2030-07-01T00:00:00Z\"");
        mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(inverted))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));
    }

    // --- Edit (PATCH) ---

    @Test
    void adminEditsEventAuditedAndSignalled() throws Exception {
        Event seeded = seedEvent("Edit me", Instant.parse("2030-01-01T00:00:00Z"), Instant.parse("2030-02-01T00:00:00Z"));
        long id = seeded.getId();

        mockMvc.perform(patch("/api/v1/admin/events/{id}", id)
                        .with(admin("events-admin-edit"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"heading\":\"Edited heading\",\"capacity\":12}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.heading").value("Edited heading"))
                .andExpect(jsonPath("$.capacity").value(12))
                // untouched fields survive a partial edit
                .andExpect(jsonPath("$.locationText").value("Marhaba Cafe, 12 High St"))
                .andExpect(jsonPath("$.status").value("PUBLISHED"));

        Event reloaded = events.findById(id).orElseThrow();
        assertThat(reloaded.getHeading()).isEqualTo("Edited heading");
        assertThat(reloaded.getCapacity()).isEqualTo(12);
        assertThat(auditActionsFor(id)).contains(AuditAction.EVENT_UPDATED);
        assertThat(lifecycleSignals(id, EventLifecycleEvent.Kind.UPDATED)).hasSize(1);
    }

    @Test
    void noOpPatchNeitherAuditsNorSignals() throws Exception {
        Event seeded = seedEvent("No-op", Instant.parse("2030-01-01T00:00:00Z"), Instant.parse("2030-02-01T00:00:00Z"));
        long id = seeded.getId();

        mockMvc.perform(patch("/api/v1/admin/events/{id}", id)
                        .with(admin("events-admin-noop"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.heading").value("No-op"));

        assertThat(auditActionsFor(id)).doesNotContain(AuditAction.EVENT_UPDATED);
        assertThat(lifecycleSignals(id, EventLifecycleEvent.Kind.UPDATED)).isEmpty();
    }

    @Test
    void patchRejectsWindowInvertedAgainstUnpatchedSide() throws Exception {
        // The request only carries visibilityEnd, which is valid on its own — but inverted against
        // the event's existing visibilityStart. Only the merged-state check can catch this.
        Event seeded = seedEvent(
                "Merged window", Instant.parse("2030-01-01T00:00:00Z"), Instant.parse("2030-02-01T00:00:00Z"));

        mockMvc.perform(patch("/api/v1/admin/events/{id}", seeded.getId())
                        .with(admin("events-admin-window"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"visibilityEnd\":\"2029-12-01T00:00:00Z\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Bad request"));
    }

    @Test
    void patchPersistsTheEventImagePathAndRejectsNonStoragePaths() throws Exception {
        Event seeded = seedEvent("Image", Instant.parse("2030-01-01T00:00:00Z"), Instant.parse("2030-02-01T00:00:00Z"));
        long id = seeded.getId();

        // the avatar-pattern flow: upload to Storage, then persist the object path
        mockMvc.perform(patch("/api/v1/admin/events/{id}", id)
                        .with(admin("events-admin-image"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"imagePath\":\"event-images/" + id + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.imagePath").value("event-images/" + id));
        assertThat(events.findById(id).orElseThrow().getImagePath()).isEqualTo("event-images/" + id);

        // a URL (or any non event-images path) is not a storage object path
        mockMvc.perform(patch("/api/v1/admin/events/{id}", id)
                        .with(admin("events-admin-image"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"imagePath\":\"https://evil.example.com/x.png\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));
    }

    // --- Cancel semantics ---

    @Test
    void cancelKeepsTheRecordWithStatusCancelledAndIsIdempotent() throws Exception {
        Event seeded = seedEvent("Cancel me", Instant.parse("2030-01-01T00:00:00Z"), Instant.parse("2030-02-01T00:00:00Z"));
        long id = seeded.getId();

        mockMvc.perform(post("/api/v1/admin/events/{id}/cancel", id).with(admin("events-admin-cancel")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("CANCELLED"));

        // cancel is NOT delete: the row survives, readable, with status CANCELLED
        Event reloaded = events.findById(id).orElseThrow();
        assertThat(reloaded.getStatus()).isEqualTo(EventStatus.CANCELLED);
        assertThat(reloaded.getDeletedAt()).isNull();
        assertThat(auditActionsFor(id)).contains(AuditAction.EVENT_CANCELLED);
        assertThat(lifecycleSignals(id, EventLifecycleEvent.Kind.CANCELLED)).hasSize(1);

        // idempotent: a second cancel succeeds but neither re-audits nor re-signals
        mockMvc.perform(post("/api/v1/admin/events/{id}/cancel", id).with(admin("events-admin-cancel")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("CANCELLED"));
        assertThat(auditActionsFor(id)).containsOnlyOnce(AuditAction.EVENT_CANCELLED);
        assertThat(lifecycleSignals(id, EventLifecycleEvent.Kind.CANCELLED)).hasSize(1);
    }

    // --- Admin listing: the full inventory ---

    @Test
    void listIncludesNotYetVisibleAndCancelledEvents() throws Exception {
        // not yet publicly visible: window opens in 2031
        Event future = seedEvent(
                "Future window", Instant.parse("2031-01-01T00:00:00Z"), Instant.parse("2031-02-01T00:00:00Z"));
        // cancelled: dropped from the public listing, kept in the console
        Event cancelled = seedEvent(
                "Cancelled one", Instant.parse("2030-01-01T00:00:00Z"), Instant.parse("2030-02-01T00:00:00Z"));
        mockMvc.perform(post("/api/v1/admin/events/{id}/cancel", cancelled.getId()).with(admin("events-admin-list")))
                .andExpect(status().isOk());

        mockMvc.perform(get("/api/v1/admin/events")
                        .param("size", "100")
                        .param("sort", "id,desc")
                        .with(admin("events-admin-list")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.items[?(@.id == " + future.getId() + ")].heading").value("Future window"))
                .andExpect(jsonPath("$.items[?(@.id == " + cancelled.getId() + ")].status").value("CANCELLED"))
                .andExpect(jsonPath("$.page").value(0));
    }

    @Test
    void listRejectsUnknownSortProperty() throws Exception {
        mockMvc.perform(get("/api/v1/admin/events").param("sort", "deletedAt").with(admin("events-admin-sort")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Invalid request"));
    }

    @Test
    void adminReadsOneEventById() throws Exception {
        Event seeded = seedEvent("Read me", Instant.parse("2030-01-01T00:00:00Z"), Instant.parse("2030-02-01T00:00:00Z"));

        mockMvc.perform(get("/api/v1/admin/events/{id}", seeded.getId()).with(admin("events-admin-get")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(seeded.getId()))
                .andExpect(jsonPath("$.heading").value("Read me"))
                .andExpect(jsonPath("$.visibilityStart").value("2030-01-01T00:00:00Z"));
    }

    // --- Venue reference (TM-519): the event-create picker + back-compat ---

    @Test
    void createReferencesAnActiveVenue() throws Exception {
        Venue venue = seedVenue("Picker venue", true);
        String body = VALID_BODY.replace("\"capacity\": 40", "\"capacity\": 40, \"venueId\": " + venue.getId());

        String response = mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-venue"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.venueId").value(venue.getId().intValue()))
                // locationText stays the display line: a picked venue is additive, not a replacement
                .andExpect(jsonPath("$.locationText").value("Victoria Park, main gate"))
                .andReturn()
                .getResponse()
                .getContentAsString();
        long id = JsonPath.parse(response).<Number>read("$.id").longValue();
        assertThat(events.findById(id).orElseThrow().getVenueId()).isEqualTo(venue.getId());
    }

    @Test
    void createWithoutVenueKeepsBackCompatFreeTextLocation() throws Exception {
        // No venueId: the legacy free-text-only path still works — venueId comes back null.
        mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-novenue"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.venueId").doesNotExist())
                .andExpect(jsonPath("$.locationText").value("Victoria Park, main gate"));
    }

    @Test
    void createRejectsUnknownVenue() throws Exception {
        String body = VALID_BODY.replace("\"capacity\": 40", "\"capacity\": 40, \"venueId\": 999999");
        mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-badvenue"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Bad request"))
                .andExpect(jsonPath("$.detail").value("Unknown or inactive venue."));
    }

    @Test
    void createRejectsDeactivatedVenue() throws Exception {
        Venue inactive = seedVenue("Retired venue", false);
        String body = VALID_BODY.replace("\"capacity\": 40", "\"capacity\": 40, \"venueId\": " + inactive.getId());
        mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-deadvenue"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.detail").value("Unknown or inactive venue."));
    }

    @Test
    void patchRepointsEventAtAVenue() throws Exception {
        Event seeded = seedEvent("Repoint", Instant.parse("2030-01-01T00:00:00Z"), Instant.parse("2030-02-01T00:00:00Z"));
        Venue venue = seedVenue("New home", true);

        mockMvc.perform(patch("/api/v1/admin/events/{id}", seeded.getId())
                        .with(admin("events-admin-venue-patch"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"venueId\":" + venue.getId() + "}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.venueId").value(venue.getId().intValue()));

        assertThat(events.findById(seeded.getId()).orElseThrow().getVenueId()).isEqualTo(venue.getId());
    }

    @Test
    void listAndGetCarryAttendanceCounts() throws Exception {
        // TM-430: the admin projection must carry going/waitlist counts so the console shows real
        // numbers instead of "— / —".
        Event event =
                seedEvent("Counted", Instant.parse("2030-03-01T00:00:00Z"), Instant.parse("2030-04-01T00:00:00Z"));
        attend(event.getId(), "count-going-1", AttendanceState.GOING);
        attend(event.getId(), "count-going-2", AttendanceState.GOING);
        attend(event.getId(), "count-wait-1", AttendanceState.WAITLISTED);
        // A second event with no attendance proves the fallback is a real 0, not null/"—".
        Event empty =
                seedEvent("Uncounted", Instant.parse("2030-03-01T00:00:00Z"), Instant.parse("2030-04-01T00:00:00Z"));

        // Single GET carries both counts.
        mockMvc.perform(get("/api/v1/admin/events/{id}", event.getId()).with(admin("events-admin-counts")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.goingCount").value(2))
                .andExpect(jsonPath("$.waitlistCount").value(1));

        // The list carries per-event counts (one tally query, no N+1); the countless event is 0/0.
        mockMvc.perform(get("/api/v1/admin/events")
                        .param("size", "100")
                        .param("sort", "id,desc")
                        .with(admin("events-admin-counts")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[?(@.id == " + event.getId() + ")].goingCount").value(2))
                .andExpect(jsonPath("$.items[?(@.id == " + event.getId() + ")].waitlistCount").value(1))
                .andExpect(jsonPath("$.items[?(@.id == " + empty.getId() + ")].goingCount").value(0))
                .andExpect(jsonPath("$.items[?(@.id == " + empty.getId() + ")].waitlistCount").value(0));
    }
}
