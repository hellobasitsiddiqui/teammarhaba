package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The heart of TM-408 exercised over real HTTP + Postgres: the public events API is a server-side
 * <b>data-leak guard</b>. Before an event's reveal boundary ({@code now < startAt − revealHours})
 * the exact-location fields ({@code locationText}, {@code mapUrl}, {@code onlineUrl}) must be
 * <em>absent</em> from the list and detail JSON — not merely blanked — while the coarse {@code city}
 * hint, {@code locationRevealsAt} and {@code locationRevealed:false} are exposed. After the boundary
 * (on the next read) the exact fields appear. The guard is uniform for every caller, GOING included.
 *
 * <p>Boundary math and the override→city→app fallback are unit-pinned in
 * {@code LocationRevealPolicyTest}; this class pins the HTTP contract end to end. Test-profile
 * config has no per-city map, so events here drive the window via the per-event override or the
 * shipped 24h app default.
 */
@AutoConfigureMockMvc
class EventLocationRevealIntegrationTest extends AbstractIntegrationTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private EventRepository events;

    @Autowired
    private UserRepository users;

    // ---------------------------------------------------------------- leak guard (the heart)

    @Test
    void detailOmitsExactLocationFieldsBeforeReveal() throws Exception {
        // Far-future start with the default 24h window → firmly pre-reveal, deterministically.
        Instant start = Instant.parse("2035-01-01T12:00:00Z");
        Event event = seedEvent("Hidden " + UUID.randomUUID(), start, null, "London");

        mockMvc.perform(get("/api/v1/events/" + event.getId()).with(caller("uid-hidden-" + UUID.randomUUID())))
                .andExpect(status().isOk())
                // exact-location fields are ABSENT (not null) — UI hiding is not enough
                .andExpect(jsonPath("$.locationText").doesNotExist())
                .andExpect(jsonPath("$.mapUrl").doesNotExist())
                .andExpect(jsonPath("$.onlineUrl").doesNotExist())
                // ...but the coarse hint + reveal metadata are present
                .andExpect(jsonPath("$.locationRevealed").value(false))
                .andExpect(jsonPath("$.locationRevealsAt").value("2034-12-31T12:00:00Z"))
                .andExpect(jsonPath("$.city").value("London"))
                // non-location content is unaffected
                .andExpect(jsonPath("$.description").value("Come along!"))
                .andExpect(jsonPath("$.heading").exists());
    }

    @Test
    void listCardOmitsExactLocationBeforeReveal() throws Exception {
        Instant start = Instant.parse("2035-02-01T12:00:00Z");
        Event event = seedEvent("Card-hidden " + UUID.randomUUID(), start, null, "Dubai");

        JsonNode card = cardFor(event, caller("uid-cardhide-" + UUID.randomUUID()));

        assertThat(card.has("locationText")).as("exact venue absent from the card pre-reveal").isFalse();
        assertThat(card.get("locationRevealed").asBoolean()).isFalse();
        assertThat(card.get("city").asText()).isEqualTo("Dubai");
        assertThat(card.get("locationRevealsAt").asText()).isEqualTo("2035-01-31T12:00:00Z");
    }

    @Test
    void withholdingIsUniformForGoingAttendees() throws Exception {
        // AC5: an RSVP'd (GOING) attendee sees exactly the same withholding as anyone else.
        Instant start = Instant.parse("2035-03-01T12:00:00Z");
        Event event = seedEvent("Going-hidden " + UUID.randomUUID(), start, null, "London");
        RequestPostProcessor me = caller("uid-going-" + UUID.randomUUID());

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(me))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"));

        mockMvc.perform(get("/api/v1/events/" + event.getId()).with(me))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.myState").value("GOING"))
                .andExpect(jsonPath("$.locationText").doesNotExist())
                .andExpect(jsonPath("$.locationRevealed").value(false));
    }

    // ---------------------------------------------------------------- after reveal

    @Test
    void detailExposesExactLocationAfterReveal() throws Exception {
        // Starts in 30 minutes; with the 24h default the reveal boundary is well in the past.
        Instant start = Instant.now().plus(30, ChronoUnit.MINUTES);
        Event event = seedEvent("Revealed " + UUID.randomUUID(), start, null, "London");

        mockMvc.perform(get("/api/v1/events/" + event.getId()).with(caller("uid-shown-" + UUID.randomUUID())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.locationRevealed").value(true))
                .andExpect(jsonPath("$.locationText").value("Secret Cafe, 12 High St"))
                .andExpect(jsonPath("$.mapUrl").value("https://maps.example/secret"))
                .andExpect(jsonPath("$.onlineUrl").value("https://meet.example/secret"))
                .andExpect(jsonPath("$.city").value("London"));
    }

    // ---------------------------------------------------------------- boundary just-before / just-after

    @Test
    void boundaryJustBeforeHidesAndJustAfterReveals() throws Exception {
        Instant now = Instant.now();

        // reveal window 10h: boundary = start − 10h. Put start so the boundary is 5 min AWAY (future).
        Event justBefore =
                seedEvent("Just-before " + UUID.randomUUID(), now.plus(10, ChronoUnit.HOURS).plus(5, ChronoUnit.MINUTES), 10, "London");
        // ...and 5 min AGO (past) for the just-after case.
        Event justAfter =
                seedEvent("Just-after " + UUID.randomUUID(), now.plus(10, ChronoUnit.HOURS).minus(5, ChronoUnit.MINUTES), 10, "London");

        mockMvc.perform(get("/api/v1/events/" + justBefore.getId()).with(caller("uid-jb-" + UUID.randomUUID())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.locationRevealed").value(false))
                .andExpect(jsonPath("$.locationText").doesNotExist());

        mockMvc.perform(get("/api/v1/events/" + justAfter.getId()).with(caller("uid-ja-" + UUID.randomUUID())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.locationRevealed").value(true))
                .andExpect(jsonPath("$.locationText").value("Secret Cafe, 12 High St"));
    }

    // ---------------------------------------------------------------- fixtures

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    private Long creatorId() {
        return users.save(new User("uid-reveal-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
                .getId();
    }

    /** A PUBLISHED, visible-now event with the exact-location fields set and the given reveal inputs. */
    private Event seedEvent(String heading, Instant startAt, Integer revealHours, String city) {
        Instant now = Instant.now();
        Event event = new Event(
                heading,
                "Come along!",
                "Secret Cafe, 12 High St",
                "Europe/London",
                startAt,
                now.minus(1, ChronoUnit.HOURS), // visible-now: window already open
                startAt.plus(1, ChronoUnit.HOURS), // ...and still open past the start
                creatorId(),
                now);
        event.setMapUrl("https://maps.example/secret");
        event.setOnlineUrl("https://meet.example/secret");
        event.setCity(city);
        event.setLocationRevealHours(revealHours);
        return events.saveAndFlush(event);
    }

    /** The listing card for one event, as seen by {@code viewer}. */
    private JsonNode cardFor(Event event, RequestPostProcessor viewer) throws Exception {
        String body = mockMvc.perform(get("/api/v1/events?size=100").with(viewer))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        for (JsonNode item : JSON.readTree(body).get("items")) {
            if (item.get("id").asLong() == event.getId()) {
                return item;
            }
        }
        throw new AssertionError("event " + event.getId() + " not in listing");
    }
}
