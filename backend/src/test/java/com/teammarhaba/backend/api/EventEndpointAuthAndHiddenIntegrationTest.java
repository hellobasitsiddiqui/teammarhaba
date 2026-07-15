package com.teammarhaba.backend.api;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

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
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The full {@code /api/v1/events} auth + existence-leak contract, exercised across <em>every</em>
 * verb the controller exposes — the TM-738 P1 gap ({@code
 * rsvpEndpoints_return401ForAnonAnd404ForHiddenEventOnEveryVerb}). Characterization only: it pins
 * the behaviour {@link EventController} already ships (this suite adds no source), and every case
 * must pass green.
 *
 * <p>Two invariants, asserted route-by-route so a regression on any single verb is caught rather
 * than hidden behind the two verbs {@code EventControllerIntegrationTest} already spot-checks
 * (which cover only GET/POST-rsvp/POST-claim for 401, and GET/POST-rsvp for the hidden 404):
 *
 * <ul>
 *   <li><b>Anonymous → uniform 401.</b> The security chain is default-deny, so an unauthenticated
 *       request to any events route is the same RFC 7807 {@code 401} — never a 403, never a leak of
 *       whether the event exists. Proven for the two GETs, POST/DELETE rsvp, POST claim, GET
 *       entitlement, and the two checkout POSTs.</li>
 *   <li><b>Hidden event → 404 on every visibility-gated verb.</b> A cancelled / not-yet-visible /
 *       soft-deleted event is a plain {@code 404} on both reads and every mutation that reads the
 *       event publicly, so the surface never leaks that a hidden event exists (and mutations can't
 *       touch it). The 404 fires on the event-visibility gate ({@code lockedVisibleEvent} /
 *       {@code EntitlementService.resolve}) which those verbs hit <em>before</em> any capacity, age,
 *       or paid-event logic — so it holds even though the test profile runs with
 *       {@code app.membership.enabled: true} (the paid gate is downstream of the 404, never in front
 *       of it). The deliberate exceptions are the two <b>leave-family</b> verbs — {@code DELETE /rsvp}
 *       and {@code POST /checkout/cancel} (which reverses through the same {@code cancelRsvp} leave
 *       path): both are visibility-decoupled (TM-729) so an attendee is never trapped in a hidden
 *       event, so each is a quiet idempotent {@code 200} on a hidden-but-present event and 404s only a
 *       genuinely absent/soft-deleted one — pinned as their own case rather than folded into the
 *       sweep.</li>
 * </ul>
 *
 * <p>Callers authenticate through the same {@link RequestPostProcessor} seam as
 * {@code EventControllerIntegrationTest}; the shared Testcontainers DB means every fixture is
 * uniquely tagged so nothing collides with a sibling suite.
 */
@AutoConfigureMockMvc
class EventEndpointAuthAndHiddenIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private EventRepository events;

    @Autowired
    private UserRepository users;

    // ------------------------------------------------------------------ 401 on every verb

    @Test
    void everyEventsVerbIs401ForAnAnonymousCaller() throws Exception {
        // A real, visible event exists — so a 401 (not a 404) proves the security chain rejects the
        // anonymous caller BEFORE any handler runs: existence is irrelevant when you are not signed in.
        Event event = saveEvent("Anon-verbs " + UUID.randomUUID(), e -> {});
        long id = event.getId();

        for (MockHttpServletRequestBuilder verb : everyVerb(id)) {
            mockMvc.perform(verb).andExpect(status().isUnauthorized());
        }
    }

    // ------------------------------------------------------------------ 404 on every verb (hidden events)

    @Test
    void everyVisibilityGatedEventsVerbIs404ForACancelledEvent() throws Exception {
        Event cancelled = saveEvent("Cancelled-verbs " + UUID.randomUUID(), e -> {});
        cancelled.cancel(Instant.now());
        events.save(cancelled);
        RequestPostProcessor me = caller("uid-hidden-cancelled-" + UUID.randomUUID());

        assertEveryVisibilityGatedVerbIsNotFound(cancelled.getId(), me);
    }

    @Test
    void everyVisibilityGatedEventsVerbIs404ForANotYetVisibleEvent() throws Exception {
        Instant now = Instant.now();
        Event notYetVisible = saveEvent("Hidden-verbs " + UUID.randomUUID(), e -> {
            // Visibility window opens tomorrow: PUBLISHED but not yet public.
            e.setVisibilityStart(now.plus(1, ChronoUnit.DAYS));
            e.setVisibilityEnd(now.plus(9, ChronoUnit.DAYS));
        });
        RequestPostProcessor me = caller("uid-hidden-window-" + UUID.randomUUID());

        assertEveryVisibilityGatedVerbIsNotFound(notYetVisible.getId(), me);
    }

    @Test
    void everyEventsVerbIncludingLeaveIs404ForAGenuinelyMissingEvent() throws Exception {
        // A genuinely absent id 404s on EVERY route — including DELETE /rsvp, whose leave path 404s only
        // for a truly absent/soft-deleted event (see the un-RSVP carve-out below), so the full verb set
        // applies here.
        RequestPostProcessor me = caller("uid-missing-" + UUID.randomUUID());

        for (MockHttpServletRequestBuilder verb : idScopedVerbs(999_999_999L)) {
            mockMvc.perform(verb.with(me)).andExpect(status().isNotFound());
        }
    }

    @Test
    void leaveFamilyVerbsAreQuietIdempotentNoOpsNotA404OnAHiddenButPresentEvent() throws Exception {
        // The deliberate leave carve-out (TM-729): both leave-family verbs — DELETE /rsvp and
        // POST /checkout/cancel (which reverses through the same visibility-decoupled cancelRsvp leave
        // path) — are decoupled from the visibility gate so an attendee is NEVER trapped in a cancelled
        // / window-slipped event. Leaving a hidden-but-present event they aren't attending is a quiet
        // idempotent 200 (no spot to surrender), NOT the 404 the read/join verbs return. Pinned so the
        // carve-out can't silently regress into a 404 that would re-trap attendees. A genuinely absent
        // event still 404s both leave verbs (asserted above).
        Instant now = Instant.now();
        Event cancelled = saveEvent("Leave-hidden " + UUID.randomUUID(), e -> {});
        cancelled.cancel(now);
        events.save(cancelled);
        Event notYetVisible = saveEvent("Leave-window " + UUID.randomUUID(), e -> {
            e.setVisibilityStart(now.plus(1, ChronoUnit.DAYS));
            e.setVisibilityEnd(now.plus(9, ChronoUnit.DAYS));
        });

        for (Event hidden : List.of(cancelled, notYetVisible)) {
            RequestPostProcessor me = caller("uid-leave-hidden-" + UUID.randomUUID());
            mockMvc.perform(delete("/api/v1/events/" + hidden.getId() + "/rsvp").with(me))
                    .andExpect(status().isOk());
            mockMvc.perform(post("/api/v1/events/" + hidden.getId() + "/checkout/cancel").with(me))
                    .andExpect(status().isOk());
        }
    }

    // ------------------------------------------------------------------ fixtures

    /**
     * Every id-scoped events verb (i.e. excluding the collection {@code GET /events} listing, which
     * has no event id). The order mirrors {@link EventController}: detail, rsvp, un-rsvp, claim,
     * entitlement, checkout, checkout-cancel.
     */
    private static List<MockHttpServletRequestBuilder> idScopedVerbs(long id) {
        String base = "/api/v1/events/" + id;
        return List.of(
                get(base),
                post(base + "/rsvp"),
                delete(base + "/rsvp"),
                post(base + "/claim"),
                get(base + "/entitlement"),
                post(base + "/checkout"),
                post(base + "/checkout/cancel"));
    }

    /**
     * The id-scoped verbs that are <em>gated on event visibility</em> — the read/join family: detail,
     * rsvp, claim, entitlement, and checkout. Excluded are the two <b>leave-family</b> verbs,
     * {@code DELETE /rsvp} and {@code POST /checkout/cancel} (the latter reverses through the same
     * {@code cancelRsvp} leave path), which are deliberately visibility-decoupled (TM-729): leaving a
     * hidden-but-present event is a quiet idempotent no-op, not a 404, so an attendee is never trapped
     * in a cancelled / window-slipped event. Their distinct behaviour is pinned separately by
     * {@link #leaveFamilyVerbsAreQuietIdempotentNoOpsNotA404OnAHiddenButPresentEvent()}.
     */
    private static List<MockHttpServletRequestBuilder> visibilityGatedVerbs(long id) {
        String base = "/api/v1/events/" + id;
        return List.of(
                get(base),
                post(base + "/rsvp"),
                post(base + "/claim"),
                get(base + "/entitlement"),
                post(base + "/checkout"));
    }

    /** Every events verb, id-scoped ones plus the collection listing — for the anonymous 401 sweep. */
    private static List<MockHttpServletRequestBuilder> everyVerb(long id) {
        List<MockHttpServletRequestBuilder> verbs = new java.util.ArrayList<>(idScopedVerbs(id));
        verbs.add(get("/api/v1/events")); // the listing has no id, but still requires a signed-in caller
        return verbs;
    }

    /** Assert every visibility-gated verb 404s for {@code caller} on a hidden event (DELETE excluded). */
    private void assertEveryVisibilityGatedVerbIsNotFound(long id, RequestPostProcessor caller) throws Exception {
        for (MockHttpServletRequestBuilder verb : visibilityGatedVerbs(id)) {
            mockMvc.perform(verb.with(caller)).andExpect(status().isNotFound());
        }
    }

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    private Long creatorId() {
        return users.save(new User("uid-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
                .getId();
    }

    /** A PUBLISHED, visible-now event starting in 2 days; {@code tweak} customises the fixture. */
    private Event saveEvent(String heading, Consumer<Event> tweak) {
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
        tweak.accept(event);
        return events.save(event);
    }
}
