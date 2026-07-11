package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The event listing-state contract over real HTTP + Postgres (TM-412, updated by TM-518): the public
 * events API surfaces <b>live</b> events ("happening now", sorted to the top) alongside upcoming ones,
 * tags each with a temporal {@code status} + {@code happeningNow} flag, and — since TM-518 supersedes
 * TM-412's hide-once-finished — <b>surfaces finished</b> events too, tagged {@link
 * com.teammarhaba.backend.event.EventPhase#FINISHED} as the read-only "Past events" section rather
 * than dropping them; a finished event's detail is served read-only (200), not 404. The boundaries
 * (upcoming / happening-now / just-finished) and the open-ended (no-{@code end_at}) default duration
 * are all exercised end to end. Boundary arithmetic is unit-pinned in {@code EventPhasePolicyTest};
 * this class pins the HTTP contract.
 *
 * <p>The suite shares one database, so listing assertions filter to this test's own events (by a
 * unique run prefix) rather than asserting absolute page contents. The test profile pins the
 * open-ended default to 3h (see {@code application-test.yml}), so the offsets below are deterministic.
 */
@AutoConfigureMockMvc
class EventListingStateIntegrationTest extends AbstractIntegrationTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private EventRepository events;

    @Autowired
    private UserRepository users;

    // ------------------------------------------------------------------ happening-now + ordering

    @Test
    void listingSurfacesLiveEventsWithStateAndSortsThemAboveUpcoming() throws Exception {
        String run = "run-" + UUID.randomUUID();
        Instant now = Instant.now();
        // Live now (started 2h ago, ends in 1h) and genuinely upcoming (starts in 10 min).
        Event live = seed(run + " live", now.minus(2, ChronoUnit.HOURS), now.plus(1, ChronoUnit.HOURS));
        Event upcoming = seed(run + " upcoming", now.plus(10, ChronoUnit.MINUTES), now.plus(4, ChronoUnit.HOURS));

        RequestPostProcessor viewer = caller("uid-state-" + run);
        List<JsonNode> cards = myCards(run, viewer);
        List<String> order = cards.stream().map(c -> c.get("heading").asText()).toList();

        // Live sorts to the top: it appears before the upcoming event even though the upcoming one
        // starts very soon — a started event always precedes a not-yet-started one.
        assertThat(order.indexOf(run + " live"))
                .as("live event surfaced above upcoming")
                .isLessThan(order.indexOf(run + " upcoming"));

        JsonNode liveCard = cardById(cards, live.getId());
        assertThat(liveCard.get("status").asText()).isEqualTo("HAPPENING_NOW");
        assertThat(liveCard.get("happeningNow").asBoolean()).isTrue();

        JsonNode upcomingCard = cardById(cards, upcoming.getId());
        assertThat(upcomingCard.get("status").asText()).isEqualTo("UPCOMING");
        assertThat(upcomingCard.get("happeningNow").asBoolean()).isFalse();
    }

    // ------------------------------------------------------------------ finished → past section (TM-518)

    @Test
    void finishedEventsSurfaceInTheListingTaggedFinishedAndDetailIsReadOnly() throws Exception {
        String run = "run-" + UUID.randomUUID();
        Instant now = Instant.now();
        // Finished (started 5h ago, ended 1h ago) inside a wide-open visibility window: TM-518 keeps it
        // in the listing as a read-only "Past events" card rather than hiding it. A live control proves
        // the active listing is unaffected.
        Event finished = seed(run + " finished", now.minus(5, ChronoUnit.HOURS), now.minus(1, ChronoUnit.HOURS));
        Event live = seed(run + " live", now.minus(1, ChronoUnit.HOURS), now.plus(1, ChronoUnit.HOURS));

        List<JsonNode> cards = myCards(run, caller("uid-fin-" + run));
        List<String> headings = cards.stream().map(c -> c.get("heading").asText()).toList();

        // Both surface now; the finished card carries the FINISHED phase tag and is not "happening now".
        assertThat(headings).contains(run + " live", run + " finished");
        JsonNode finishedCard = cardById(cards, finished.getId());
        assertThat(finishedCard.get("status").asText()).isEqualTo("FINISHED");
        assertThat(finishedCard.get("happeningNow").asBoolean()).isFalse();

        // ...and the finished event's detail is served read-only (200), tagged FINISHED — no longer a 404.
        mockMvc.perform(get("/api/v1/events/" + finished.getId()).with(caller("uid-fin2-" + run)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("FINISHED"))
                .andExpect(jsonPath("$.happeningNow").value(false));
    }

    // ------------------------------------------------------------------ live detail carries state

    @Test
    void liveEventDetailCarriesHappeningNowState() throws Exception {
        Instant now = Instant.now();
        Event live = seed("Live detail " + UUID.randomUUID(), now.minus(30, ChronoUnit.MINUTES), now.plus(2, ChronoUnit.HOURS));

        mockMvc.perform(get("/api/v1/events/" + live.getId()).with(caller("uid-livedetail-" + UUID.randomUUID())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("HAPPENING_NOW"))
                .andExpect(jsonPath("$.happeningNow").value(true));
    }

    // ------------------------------------------------------------------ open-ended (null end_at) default

    @Test
    void openEndedEventStaysLiveWithinDefaultWindowThenTurnsPast() throws Exception {
        String run = "run-" + UUID.randomUUID();
        Instant now = Instant.now();
        // Both have no end_at → the 3h test default decides. Started 1h ago = still live; started 5h
        // ago = past the assumed 3h duration = finished (and, since TM-518, surfaced as a past card).
        Event stillLive = seed(run + " open-live", now.minus(1, ChronoUnit.HOURS), null);
        Event doneNoEnd = seed(run + " open-finished", now.minus(5, ChronoUnit.HOURS), null);

        List<JsonNode> cards = myCards(run, caller("uid-open-" + run));
        List<String> headings = cards.stream().map(c -> c.get("heading").asText()).toList();

        // The live one is HAPPENING_NOW; the one past the default window is now a FINISHED (past) card,
        // no longer dropped.
        assertThat(headings)
                .as("open-ended event within the default window is live; past it, it becomes a past card")
                .contains(run + " open-live", run + " open-finished");
        assertThat(cardById(cards, stillLive.getId()).get("happeningNow").asBoolean()).isTrue();
        assertThat(cardById(cards, doneNoEnd.getId()).get("status").asText()).isEqualTo("FINISHED");

        // The past open-ended event's detail is served read-only (200), tagged FINISHED — no longer 404.
        mockMvc.perform(get("/api/v1/events/" + doneNoEnd.getId()).with(caller("uid-open2-" + run)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("FINISHED"));
    }

    // ------------------------------------------------------------------ fixtures

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    private Long creatorId() {
        return users.save(new User("uid-state-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
                .getId();
    }

    /**
     * A PUBLISHED event with the given start / end (end may be {@code null} = open-ended) and a wide
     * visibility window (now−1d … now+30d) so the visibility filter is never the reason an event is
     * hidden — the listing-state rule is what's under test.
     */
    private Event seed(String heading, Instant startAt, Instant endAt) {
        Instant now = Instant.now();
        Event event = new Event(
                heading,
                "Come along!",
                "Marhaba Cafe",
                "Europe/London",
                startAt,
                now.minus(1, ChronoUnit.DAYS),
                now.plus(30, ChronoUnit.DAYS),
                creatorId(),
                now);
        event.setEndAt(endAt);
        return events.saveAndFlush(event);
    }

    /** This run's cards from the listing (big page, shared DB), in listing order. */
    private List<JsonNode> myCards(String runPrefix, RequestPostProcessor viewer) throws Exception {
        String body = mockMvc.perform(get("/api/v1/events?size=200").with(viewer))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        List<JsonNode> mine = new ArrayList<>();
        for (JsonNode item : JSON.readTree(body).get("items")) {
            if (item.get("heading").asText().startsWith(runPrefix)) {
                mine.add(item);
            }
        }
        return mine;
    }

    private static JsonNode cardById(List<JsonNode> cards, Long id) {
        return cards.stream()
                .filter(c -> c.get("id").asLong() == id)
                .findFirst()
                .orElseThrow(() -> new AssertionError("event " + id + " not in listing"));
    }
}
