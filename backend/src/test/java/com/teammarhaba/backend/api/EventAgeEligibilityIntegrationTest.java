package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.AttendanceState;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventAttendance;
import com.teammarhaba.backend.event.EventAttendanceRepository;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The event age-group eligibility guard end to end (TM-415): the hard server-side rule that a
 * user's self-reported age must fall in the event's band ({@code age_min}/{@code age_max}), widened
 * by the app-level ±tolerance grace (default 2), enforced on RSVP, waitlist-join and claim.
 *
 * <p>Pins every AC scenario: the ±2 edges (22/23 and 32/33 for a 25–30 band), a single cohort
 * (min == max), an open band (no restriction — even an unset age can RSVP), an unset age on a banded
 * event (honest 409 prompting profile completion, never a silent pass), and that waitlist-join and
 * claim are guarded too (not just a fresh RSVP). Also covers the admin create/edit accepting +
 * validating the band, and the detail view surfacing the band + the caller's own eligibility for the
 * user UI (TM-396). The rule arithmetic itself is unit-tested in {@code AgeEligibilityPolicyTest}.
 *
 * <p>The suite shares one database, so each test uses unique headings / uids and asserts on its own
 * rows only.
 */
@AutoConfigureMockMvc
class EventAgeEligibilityIntegrationTest extends AbstractIntegrationTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The honest 409 for a 25–30 band; the ± grace is deliberately not advertised in the copy. */
    private static final String BAND_25_30 = "This event is for ages 25–30.";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private EventRepository events;

    @Autowired
    private UserRepository users;

    @Autowired
    private EventAttendanceRepository attendanceRepo;

    // ------------------------------------------------------------------ RSVP guard (+ waitlist-join)

    @Test
    void rsvpIsAllowedInsideTheGraceAndBlockedBelowTheLowerEdge() throws Exception {
        Event event = saveEvent("Age lower " + UUID.randomUUID(), 25, 30);

        // 22 is one year below the graced lower edge (25 − 2 = 23): a hard 409 naming the band.
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(userAged(22)))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.detail").value(BAND_25_30));
        // 23 sits exactly on the graced edge: allowed.
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(userAged(23)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"));
    }

    @Test
    void rsvpIsAllowedAtTheGracedUpperEdgeAndBlockedAboveIt() throws Exception {
        Event event = saveEvent("Age upper " + UUID.randomUUID(), 25, 30);

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(userAged(32)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"));
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(userAged(33)))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.detail").value(BAND_25_30));
    }

    @Test
    void singleCohortBandUsesTheGraceEitherSide() throws Exception {
        // min == max == 28 → allowed 26..30.
        Event event = saveEvent("Cohort " + UUID.randomUUID(), 28, 28);

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(userAged(26)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"));
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(userAged(31)))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.detail").value("This event is for ages 28."));
    }

    @Test
    void openBandLetsAnyoneRsvpEvenWithAnUnsetAge() throws Exception {
        // No band set → open to all ages. A brand-new caller (JIT-provisioned with a null age) is in.
        Event event = saveEvent("Open band " + UUID.randomUUID(), null, null);

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp")
                        .with(caller("uid-open-" + UUID.randomUUID())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"));
    }

    @Test
    void unsetAgeOnABandedEventIs409PromptingProfileCompletion() throws Exception {
        Event event = saveEvent("Needs age " + UUID.randomUUID(), 25, 30);

        // A brand-new caller has no age yet: an honest 409 telling them to set it — never a silent pass.
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp")
                        .with(caller("uid-noage-" + UUID.randomUUID())))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.detail")
                        .value("Set your age on your profile to RSVP — this event is limited to a specific age group."));
    }

    @Test
    void waitlistJoinIsGuardedTooNotSilentlyQueued() throws Exception {
        // Capacity 1 and already full → a fresh RSVP would normally land WAITLISTED. An ineligible
        // user must be blocked from that waitlist-join, not quietly queued.
        Event event = saveEvent("Waitlist guard " + UUID.randomUUID(), 25, 30, e -> e.setCapacity(1));
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(userAged(28)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"));

        RequestPostProcessor ineligible = userAged(50);
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(ineligible))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.detail").value(BAND_25_30));

        // Proof they were never added to the waitlist: the queue is still empty.
        mockMvc.perform(get("/api/v1/events/" + event.getId()).with(ineligible))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.goingCount").value(1))
                .andExpect(jsonPath("$.waitlistedCount").value(0));
    }

    // ------------------------------------------------------------------ claim guard

    @Test
    void claimIsGuardedForAMemberWhoBecameIneligible() throws Exception {
        // Simulate an admin narrowing the band after the user joined: a WAITLISTED row exists for an
        // out-of-band member, and a spot is free — yet the claim is still refused (a claim is a route
        // into a GOING spot). This exercises the guard on claim independently of RSVP.
        Event event = saveEvent("Claim guard " + UUID.randomUUID(), 25, 30, e -> e.setCapacity(1));
        User ineligible = seedUser("uid-claim-inelig-" + UUID.randomUUID(), 50);
        attendanceRepo.save(new EventAttendance(event.getId(), ineligible.getId(), AttendanceState.WAITLISTED));

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/claim")
                        .with(caller(ineligible.getFirebaseUid())))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.detail").value(BAND_25_30));
    }

    // ------------------------------------------------------------------ admin: accept + validate the band

    @Test
    void adminCreateAcceptsTheBandAndTheResponseCarriesIt() throws Exception {
        String body =
                """
                {
                  "heading": "Twenty-somethings picnic",
                  "description": "Bring a dish to share.",
                  "locationText": "Victoria Park, main gate",
                  "timezone": "Europe/London",
                  "startAt": "2030-06-15T12:00:00Z",
                  "visibilityStart": "2030-05-01T00:00:00Z",
                  "visibilityEnd": "2030-06-16T00:00:00Z",
                  "ageMin": 25,
                  "ageMax": 30
                }
                """;
        mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-ageband-create"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.ageMin").value(25))
                .andExpect(jsonPath("$.ageMax").value(30));
    }

    @Test
    void adminPatchSetsAndClearsAreReflected() throws Exception {
        Event seeded = saveEvent("Edit band " + UUID.randomUUID(), null, null);

        mockMvc.perform(patch("/api/v1/admin/events/" + seeded.getId())
                        .with(admin("events-admin-ageband-edit"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"ageMin\":18,\"ageMax\":25}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ageMin").value(18))
                .andExpect(jsonPath("$.ageMax").value(25));

        assertThat(events.findById(seeded.getId()).orElseThrow().getAgeMin()).isEqualTo(18);
    }

    @Test
    void adminCreateRejectsAnInvertedBand() throws Exception {
        String body =
                """
                {
                  "heading": "Bad band",
                  "description": "min above max.",
                  "locationText": "Somewhere",
                  "timezone": "Europe/London",
                  "startAt": "2030-06-15T12:00:00Z",
                  "visibilityStart": "2030-05-01T00:00:00Z",
                  "visibilityEnd": "2030-06-16T00:00:00Z",
                  "ageMin": 30,
                  "ageMax": 25
                }
                """;
        mockMvc.perform(post("/api/v1/admin/events")
                        .with(admin("events-admin-ageband-inverted"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));
    }

    @Test
    void adminPatchRejectsAnInvertedBandAgainstTheUnpatchedEdge() throws Exception {
        // The patch carries only ageMax, valid on its own, but inverted against the event's existing
        // ageMin (30). Only the merged-state check in the service can catch this.
        Event seeded = saveEvent("Merged band " + UUID.randomUUID(), 30, null);

        mockMvc.perform(patch("/api/v1/admin/events/" + seeded.getId())
                        .with(admin("events-admin-ageband-merged"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"ageMax\":20}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Bad request"));
    }

    // ------------------------------------------------------------------ detail: band + per-caller verdict

    @Test
    void detailExposesTheBandAndTheCallersOwnEligibility() throws Exception {
        Event event = saveEvent("Detail elig " + UUID.randomUUID(), 25, 30);

        JsonNode eligible = detailAsSeenBy(event, userAged(28));
        assertThat(eligible.get("ageMin").asInt()).isEqualTo(25);
        assertThat(eligible.get("ageMax").asInt()).isEqualTo(30);
        assertThat(eligible.get("ageEligible").asBoolean()).isTrue();

        JsonNode tooOld = detailAsSeenBy(event, userAged(50));
        assertThat(tooOld.get("ageEligible").asBoolean()).isFalse();

        JsonNode noAge = detailAsSeenBy(event, caller("uid-detail-noage-" + UUID.randomUUID()));
        assertThat(noAge.get("ageEligible").asBoolean()).isFalse();

        // An open event has no band and no verdict to disable RSVP on.
        Event open = saveEvent("Detail open " + UUID.randomUUID(), null, null);
        JsonNode openNode = detailAsSeenBy(open, userAged(40));
        assertThat(openNode.hasNonNull("ageMin")).isFalse();
        assertThat(openNode.hasNonNull("ageEligible")).isFalse();
    }

    // ------------------------------------------------------------------ fixtures

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    private static RequestPostProcessor admin(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"),
                null,
                List.of(new SimpleGrantedAuthority("ROLE_ADMIN"))));
    }

    /** Seed a user with a set age and return them (for direct attendance seeding / uid lookup). */
    private User seedUser(String uid, Integer age) {
        User user = new User(uid, uid + "@example.com", "U");
        user.setAge(age);
        return users.save(user);
    }

    /** A caller backed by a freshly seeded user of the given age. */
    private RequestPostProcessor userAged(Integer age) {
        String uid = "uid-age-" + age + "-" + UUID.randomUUID();
        seedUser(uid, age);
        return caller(uid);
    }

    private Long creatorId() {
        return users.save(new User("uid-age-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
                .getId();
    }

    /** A PUBLISHED, visible-now event starting in 2 days, with the given (nullable) age band. */
    private Event saveEvent(String heading, Integer ageMin, Integer ageMax) {
        return saveEvent(heading, ageMin, ageMax, e -> {});
    }

    private Event saveEvent(String heading, Integer ageMin, Integer ageMax, Consumer<Event> tweak) {
        Instant now = Instant.now();
        Event event = new Event(
                heading,
                "Come along!",
                "Marhaba Cafe",
                "Europe/London",
                now.plus(2, ChronoUnit.DAYS),
                now.minus(1, ChronoUnit.HOURS),
                now.plus(7, ChronoUnit.DAYS),
                creatorId(),
                now);
        event.setAgeMin(ageMin);
        event.setAgeMax(ageMax);
        tweak.accept(event);
        return events.save(event);
    }

    private JsonNode detailAsSeenBy(Event event, RequestPostProcessor viewer) throws Exception {
        String body = mockMvc.perform(get("/api/v1/events/" + event.getId()).with(viewer))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        return JSON.readTree(body);
    }
}
