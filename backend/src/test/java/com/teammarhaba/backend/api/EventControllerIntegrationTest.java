package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventAttendance;
import com.teammarhaba.backend.event.EventAttendanceRepository;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.user.UserService;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * {@code /api/v1/events} end to end (TM-393): visible-now window filtering and soonest-first
 * order on the listing, detail counts + attendee avatars resolved through {@code User}
 * (soft-deleted accounts drop out), my-state incl. {@code WAITLISTED} and the
 * {@code spotAvailableToClaim} affordance, the RSVP/un-RSVP/claim status-code contract (404 for
 * hidden events, 409 after start / for lost claims with honest copy), and the uniform 401 for
 * anonymous callers. Race semantics live in {@code EventRsvpConcurrencyIntegrationTest} — this
 * class pins the HTTP contract.
 *
 * <p>The suite shares one database, so listing assertions filter to this test's own events (by
 * unique heading) rather than asserting absolute page contents.
 */
@AutoConfigureMockMvc
class EventControllerIntegrationTest extends AbstractIntegrationTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private EventRepository events;

    @Autowired
    private UserRepository users;

    @Autowired
    private UserService userService;

    @Autowired
    private EventAttendanceRepository attendanceRepo;

    // ------------------------------------------------------------------ listing

    @Test
    void listingShowsOnlyVisibleNowEventsSoonestFirst() throws Exception {
        String run = "run-" + UUID.randomUUID();
        Long creator = creatorId();
        Instant now = Instant.now();
        saveEvent(run + " later", creator, e -> e.setStartAt(now.plus(3, ChronoUnit.DAYS)));
        saveEvent(run + " sooner", creator, e -> e.setStartAt(now.plus(1, ChronoUnit.DAYS)));
        saveEvent(run + " not-yet-visible", creator, e -> {
            e.setVisibilityStart(now.plus(1, ChronoUnit.DAYS));
            e.setVisibilityEnd(now.plus(9, ChronoUnit.DAYS));
        });
        saveEvent(run + " window-closed", creator, e -> {
            e.setVisibilityStart(now.minus(9, ChronoUnit.DAYS));
            e.setVisibilityEnd(now.minus(1, ChronoUnit.HOURS));
        });
        Event cancelled = saveEvent(run + " cancelled", creator, e -> {});
        cancelled.cancel(now);
        events.save(cancelled);

        List<String> mine = myHeadings(run);

        assertThat(mine)
                .as("in-window PUBLISHED events only, soonest start first")
                .containsExactly(run + " sooner", run + " later");
    }

    @Test
    void listingCardsCarryGoingCountAndMyState() throws Exception {
        String run = "run-" + UUID.randomUUID();
        Event event = saveEvent(run + " picnic", creatorId(), e -> e.setCapacity(1));
        RequestPostProcessor me = caller("uid-card-me-" + run);
        RequestPostProcessor other = caller("uid-card-other-" + run);
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(other))
                .andExpect(status().isOk()); // fills the event
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(me))
                .andExpect(status().isOk()); // I land on the waitlist

        JsonNode card = myCard(event, me);

        assertThat(card.get("goingCount").asLong()).isEqualTo(1);
        assertThat(card.get("myState").asText()).isEqualTo("WAITLISTED");
        assertThat(card.get("capacity").asInt()).isEqualTo(1);
        assertThat(card.hasNonNull("startAt")).isTrue();
        assertThat(card.get("timezone").asText()).isEqualTo("Europe/London");
    }

    // ------------------------------------------------------------------ detail

    @Test
    void detailCarriesCountsAndAvatarsInJoinOrderResolvedThroughUser() throws Exception {
        Event event = saveEvent("Detail " + UUID.randomUUID(), creatorId(), e -> e.setCapacity(10));
        String tag = UUID.randomUUID().toString().substring(0, 8);
        List<RequestPostProcessor> joiners = new ArrayList<>();
        for (String name : List.of("Amal", "Bilal", "Chandra")) {
            String uid = "uid-av-" + name + "-" + tag;
            users.save(new User(uid, name.toLowerCase() + "-" + tag + "@example.com", name));
            joiners.add(caller(uid));
        }
        for (RequestPostProcessor joiner : joiners) {
            mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(joiner))
                    .andExpect(status().isOk());
        }
        // Tombstone the second attendee: their spot still counts, but the avatar must drop out
        // because people resolve through the User aggregate (which hides soft-deleted accounts).
        userService.softDelete("uid-av-Bilal-" + tag);

        mockMvc.perform(get("/api/v1/events/" + event.getId()).with(joiners.get(0)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.goingCount").value(3))
                .andExpect(jsonPath("$.waitlistedCount").value(0))
                .andExpect(jsonPath("$.myState").value("GOING"))
                .andExpect(jsonPath("$.spotAvailableToClaim").value(false))
                .andExpect(jsonPath("$.attendees.length()").value(2))
                .andExpect(jsonPath("$.attendees[0].displayName").value("Amal"))
                .andExpect(jsonPath("$.attendees[1].displayName").value("Chandra"))
                .andExpect(jsonPath("$.description").value("Come along!"));
    }

    @Test
    void detailIs404ForCancelledHiddenAndMissingEvents() throws Exception {
        Long creator = creatorId();
        Instant now = Instant.now();
        Event cancelled = saveEvent("Cancelled " + UUID.randomUUID(), creator, e -> {});
        cancelled.cancel(now);
        events.save(cancelled);
        Event hidden = saveEvent("Hidden " + UUID.randomUUID(), creator, e -> {
            e.setVisibilityStart(now.plus(1, ChronoUnit.DAYS));
            e.setVisibilityEnd(now.plus(9, ChronoUnit.DAYS));
        });
        RequestPostProcessor me = caller("uid-404-" + UUID.randomUUID());

        mockMvc.perform(get("/api/v1/events/" + cancelled.getId()).with(me)).andExpect(status().isNotFound());
        mockMvc.perform(get("/api/v1/events/" + hidden.getId()).with(me)).andExpect(status().isNotFound());
        mockMvc.perform(get("/api/v1/events/999999999").with(me)).andExpect(status().isNotFound());
        // Hidden events are hidden from mutations too — not just reads.
        mockMvc.perform(post("/api/v1/events/" + hidden.getId() + "/rsvp").with(me))
                .andExpect(status().isNotFound());
    }

    // ------------------------------------------------------------------ rsvp / un-rsvp

    @Test
    void rsvpLandsGoingThenWaitlistedWhenFullAndIsIdempotent() throws Exception {
        Event event = saveEvent("Full house " + UUID.randomUUID(), creatorId(), e -> e.setCapacity(1));
        RequestPostProcessor first = caller("uid-rsvp-1-" + UUID.randomUUID());
        RequestPostProcessor second = caller("uid-rsvp-2-" + UUID.randomUUID());

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(first))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"))
                .andExpect(jsonPath("$.goingCount").value(1));
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(second))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("WAITLISTED"))
                .andExpect(jsonPath("$.waitlistedCount").value(1));
        // Re-RSVP changes nothing — same state, same counts.
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(second))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("WAITLISTED"))
                .andExpect(jsonPath("$.goingCount").value(1))
                .andExpect(jsonPath("$.waitlistedCount").value(1));
    }

    @Test
    void unRsvpFreesTheSpotWithoutPromotingAndIsIdempotent() throws Exception {
        Event event = saveEvent("Leaver " + UUID.randomUUID(), creatorId(), e -> e.setCapacity(1));
        RequestPostProcessor going = caller("uid-leave-1-" + UUID.randomUUID());
        RequestPostProcessor queued = caller("uid-leave-2-" + UUID.randomUUID());
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(going))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(queued))
                .andExpect(status().isOk());

        mockMvc.perform(delete("/api/v1/events/" + event.getId() + "/rsvp").with(going))
                .andExpect(status().isOk());

        // No auto-promotion: the freed spot is recorded (derived) for the offer cascade, and the
        // queued member is still WAITLISTED — now with a claimable open spot behind the scenes.
        mockMvc.perform(get("/api/v1/events/" + event.getId()).with(queued))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.goingCount").value(0))
                .andExpect(jsonPath("$.myState").value("WAITLISTED"));
        // Leaving again (or never having joined) is a quiet no-op.
        mockMvc.perform(delete("/api/v1/events/" + event.getId() + "/rsvp").with(going))
                .andExpect(status().isOk());
    }

    @Test
    void lateCancellationReturnsRunningCountMessageAndPreviewDoesNotCommit() throws Exception {
        // Event starting inside the 24h cancellation window: leaving a held spot is a late cancel (TM-414).
        Event event = saveEvent(
                "Latecancel " + UUID.randomUUID(),
                creatorId(),
                e -> e.setStartAt(Instant.now().plus(12, ChronoUnit.HOURS)));
        RequestPostProcessor me = caller("uid-latecancel-" + UUID.randomUUID());
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(me))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"));

        // Pre-confirm dry-run: reports the verdict + the count it WOULD reach, but writes nothing.
        mockMvc.perform(delete("/api/v1/events/" + event.getId() + "/rsvp?preview=true").with(me))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.preview").value(true))
                .andExpect(jsonPath("$.lateCancel").value(true))
                .andExpect(jsonPath("$.lateCancelCount").value(1))
                .andExpect(jsonPath("$.message").value(org.hamcrest.Matchers.containsString("late cancellation")));
        // Still GOING — the preview left the RSVP untouched.
        mockMvc.perform(get("/api/v1/events/" + event.getId()).with(me))
                .andExpect(jsonPath("$.myState").value("GOING"));

        // Commit: the strike lands and the honest message carries the running count.
        mockMvc.perform(delete("/api/v1/events/" + event.getId() + "/rsvp").with(me))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.preview").value(false))
                .andExpect(jsonPath("$.lateCancel").value(true))
                .andExpect(jsonPath("$.lateCancelCount").value(1))
                .andExpect(jsonPath("$.message").value(org.hamcrest.Matchers.containsString("your 1st")));
        // And the caller has left the event.
        mockMvc.perform(get("/api/v1/events/" + event.getId()).with(me))
                .andExpect(jsonPath("$.myState").value("NONE"));
    }

    @Test
    void attendanceChangesAfterStartAreRefusedWith409() throws Exception {
        // Started an hour ago but still inside its visibility window: readable, immutable.
        Event event = saveEvent(
                "Started " + UUID.randomUUID(),
                creatorId(),
                e -> e.setStartAt(Instant.now().minus(1, ChronoUnit.HOURS)));
        RequestPostProcessor me = caller("uid-started-" + UUID.randomUUID());

        mockMvc.perform(get("/api/v1/events/" + event.getId()).with(me)).andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(me))
                .andExpect(status().isConflict());
        mockMvc.perform(delete("/api/v1/events/" + event.getId() + "/rsvp").with(me))
                .andExpect(status().isConflict());
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/claim").with(me))
                .andExpect(status().isConflict());
    }

    // ------------------------------------------------------------------ claim + offers

    @Test
    void waitlistedMemberWithLiveOfferSeesClaimAffordanceAndCanClaim() throws Exception {
        Event event = saveEvent("Claimable " + UUID.randomUUID(), creatorId(), e -> e.setCapacity(1));
        RequestPostProcessor holder = caller("uid-claim-holder-" + UUID.randomUUID());
        String queuedUid = "uid-claim-queued-" + UUID.randomUUID();
        RequestPostProcessor queued = caller(queuedUid);
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(holder))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(queued))
                .andExpect(status().isOk());

        // Queued, no free spot, no offer: nothing to claim yet.
        mockMvc.perform(get("/api/v1/events/" + event.getId()).with(queued))
                .andExpect(jsonPath("$.myState").value("WAITLISTED"))
                .andExpect(jsonPath("$.spotAvailableToClaim").value(false));

        mockMvc.perform(delete("/api/v1/events/" + event.getId() + "/rsvp").with(holder))
                .andExpect(status().isOk());
        stampOffer(event, queuedUid); // TM-397's cascade notifies the queued member

        mockMvc.perform(get("/api/v1/events/" + event.getId()).with(queued))
                .andExpect(jsonPath("$.spotAvailableToClaim").value(true));
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/claim").with(queued))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"))
                .andExpect(jsonPath("$.goingCount").value(1))
                .andExpect(jsonPath("$.waitlistedCount").value(0));
        mockMvc.perform(get("/api/v1/events/" + event.getId()).with(queued))
                .andExpect(jsonPath("$.myState").value("GOING"))
                .andExpect(jsonPath("$.spotAvailableToClaim").value(false));
    }

    @Test
    void claimWithoutAFreeSpotIs409WithHonestCopy() throws Exception {
        Event event = saveEvent("No spot " + UUID.randomUUID(), creatorId(), e -> e.setCapacity(1));
        RequestPostProcessor holder = caller("uid-nospot-holder-" + UUID.randomUUID());
        RequestPostProcessor queued = caller("uid-nospot-queued-" + UUID.randomUUID());
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(holder))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(queued))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/claim").with(queued))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.detail")
                        .value("That spot has already been taken — you are still on the waitlist."));
        // And claiming without even being on the waitlist is a 409 too.
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/claim")
                        .with(caller("uid-nospot-stranger-" + UUID.randomUUID())))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.detail").value("You are not on the waitlist for this event."));
    }

    // ------------------------------------------------------------------ auth

    @Test
    void anonymousCallersGetTheUniform401() throws Exception {
        Event event = saveEvent("Anon " + UUID.randomUUID(), creatorId(), e -> {});

        mockMvc.perform(get("/api/v1/events")).andExpect(status().isUnauthorized());
        mockMvc.perform(get("/api/v1/events/" + event.getId())).andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp")).andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/claim")).andExpect(status().isUnauthorized());
    }

    // ------------------------------------------------------------------ fixtures

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    private Long creatorId() {
        return users.save(new User("uid-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
                .getId();
    }

    /** A PUBLISHED, visible-now event starting in 2 days; {@code tweak} customises the fixture. */
    private Event saveEvent(String heading, Long creatorId, Consumer<Event> tweak) {
        Instant now = Instant.now();
        Event event = new Event(
                heading,
                "Come along!",
                "Marhaba Cafe",
                "Europe/London",
                now.plus(2, ChronoUnit.DAYS),
                now.minus(1, ChronoUnit.HOURS),
                now.plus(7, ChronoUnit.DAYS),
                creatorId,
                now);
        tweak.accept(event);
        return events.save(event);
    }

    /** This run's headings from the listing (big page, shared DB), in listing order. */
    private List<String> myHeadings(String runPrefix) throws Exception {
        String body = mockMvc.perform(get("/api/v1/events?size=100")
                        .with(caller("uid-list-" + UUID.randomUUID())))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        List<String> headings = new ArrayList<>();
        for (JsonNode item : JSON.readTree(body).get("items")) {
            String heading = item.get("heading").asText();
            if (heading.startsWith(runPrefix)) {
                headings.add(heading);
            }
        }
        return headings;
    }

    /** The listing card for one event, as seen by {@code viewer}. */
    private JsonNode myCard(Event event, RequestPostProcessor viewer) throws Exception {
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

    /** Simulate TM-397 stamping a live offer on this member's waitlist row. */
    private void stampOffer(Event event, String uid) {
        Long userId = users.findByFirebaseUid(uid).orElseThrow().getId();
        EventAttendance row =
                attendanceRepo.findByEventIdAndUserId(event.getId(), userId).orElseThrow();
        row.recordOffer(Instant.now());
        attendanceRepo.save(row);
    }
}
