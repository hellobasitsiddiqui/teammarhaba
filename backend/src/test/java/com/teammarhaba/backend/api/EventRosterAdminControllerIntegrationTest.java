package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

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
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The TM-592 roster + capacity admin endpoints through the real security chain + Postgres. Pins the
 * RBAC gate (the four new sub-actions inherit the controller's {@code hasRole('ADMIN')}: anon → 401,
 * USER → 403) and the over-capacity warning payload the console renders. The behavioural coverage
 * (evict / force-add / cascade / audit) lives in
 * {@code EventRosterAdminServiceIntegrationTest}; this class owns the wire + auth contract.
 */
@AutoConfigureMockMvc
class EventRosterAdminControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private EventRepository events;

    @Autowired
    private EventAttendanceRepository attendance;

    @Autowired
    private UserRepository users;

    // ---------------------------------------------------------------- RBAC: the four sub-actions

    @Test
    void anonymousIsUnauthorizedOnEveryRosterEndpoint() throws Exception {
        long id = seedEvent(2).getId();
        long userId = seedUser("anon-target").getId();
        mockMvc.perform(get("/api/v1/admin/events/{id}/roster", id)).andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/admin/events/{id}/capacity", id)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"capacity\":3}"))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/admin/events/{id}/attendees", id)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"userId\":" + userId + "}"))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/admin/events/{id}/attendees/{userId}/evict", id, userId))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void regularUserIsForbiddenOnEveryRosterEndpoint() throws Exception {
        long id = seedEvent(2).getId();
        long userId = seedUser("user-target").getId();
        mockMvc.perform(get("/api/v1/admin/events/{id}/roster", id).with(regularUser("u1")))
                .andExpect(status().isForbidden());
        mockMvc.perform(post("/api/v1/admin/events/{id}/capacity", id).with(regularUser("u1"))
                        .contentType(MediaType.APPLICATION_JSON).content("{\"capacity\":3}"))
                .andExpect(status().isForbidden());
        mockMvc.perform(post("/api/v1/admin/events/{id}/attendees", id).with(regularUser("u1"))
                        .contentType(MediaType.APPLICATION_JSON).content("{\"userId\":" + userId + "}"))
                .andExpect(status().isForbidden());
        mockMvc.perform(post("/api/v1/admin/events/{id}/attendees/{userId}/evict", id, userId).with(regularUser("u1")))
                .andExpect(status().isForbidden());
    }

    // ---------------------------------------------------------------- over-cap warning payload

    @Test
    void loweringCapacityBelowGoingReturnsTheOverCapacityWarning() throws Exception {
        Event event = seedEvent(4);
        goingRow(event, seedUser("g1").getId());
        goingRow(event, seedUser("g2").getId());
        goingRow(event, seedUser("g3").getId());

        mockMvc.perform(post("/api/v1/admin/events/{id}/capacity", event.getId()).with(admin("admin1"))
                        .contentType(MediaType.APPLICATION_JSON).content("{\"capacity\":1}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.capacity").value(1))
                .andExpect(jsonPath("$.going").value(3))
                .andExpect(jsonPath("$.overCapacity").value(true))
                .andExpect(jsonPath("$.overCapacityBy").value(2))
                .andExpect(jsonPath("$.freeSpots").value(0)); // clamped >= 0, never negative

        // No auto-eviction: the three committed attendees are all still GOING.
        assertThat(attendance.countByEventIdAndState(event.getId(), AttendanceState.GOING)).isEqualTo(3);
    }

    @Test
    void negativeCapacityIsA400() throws Exception {
        long id = seedEvent(2).getId();
        mockMvc.perform(post("/api/v1/admin/events/{id}/capacity", id).with(admin("admin1"))
                        .contentType(MediaType.APPLICATION_JSON).content("{\"capacity\":-1}"))
                .andExpect(status().isBadRequest());
    }

    // ---------------------------------------------------------------- force-add via the endpoint

    @Test
    void forceAddIsOversellSafeByDefaultAnd409sOnAFullEvent() throws Exception {
        Event event = seedEvent(1);
        goingRow(event, seedUser("full1").getId());
        long target = seedUser("wants-in").getId();

        // No override -> 409 (full).
        mockMvc.perform(post("/api/v1/admin/events/{id}/attendees", event.getId()).with(admin("admin1"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":" + target + ",\"override\":false}"))
                .andExpect(status().isConflict());
        assertThat(attendance.countByEventIdAndState(event.getId(), AttendanceState.GOING)).isEqualTo(1);

        // Override -> lands GOING over cap.
        mockMvc.perform(post("/api/v1/admin/events/{id}/attendees", event.getId()).with(admin("admin1"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":" + target + ",\"override\":true}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"))
                .andExpect(jsonPath("$.going").value(2));
    }

    @Test
    void evictFreesTheSpotAndReturnsTheCounts() throws Exception {
        Event event = seedEvent(2);
        long target = seedUser("evictee").getId();
        goingRow(event, target);

        mockMvc.perform(post("/api/v1/admin/events/{id}/attendees/{userId}/evict", event.getId(), target)
                        .with(admin("admin1")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").doesNotExist())
                .andExpect(jsonPath("$.going").value(0));
        assertThat(attendance.findByEventIdAndUserId(event.getId(), target)).isEmpty();
    }

    // ---------------------------------------------------------------- fixtures

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

    private User seedUser(String tag) {
        return users.saveAndFlush(
                new User("uid-roster-ctl-" + tag + "-" + UUID.randomUUID(), tag + "@example.com", tag));
    }

    private Event seedEvent(Integer capacity) {
        Instant now = Instant.now();
        Long creatorId = seedUser("creator").getId();
        Event event = new Event(
                "Roster-ctl " + UUID.randomUUID(),
                "Seeded for the roster admin API tests.",
                "Marhaba Cafe",
                "Europe/London",
                now.plus(2, ChronoUnit.DAYS),
                now.minus(1, ChronoUnit.HOURS),
                now.plus(7, ChronoUnit.DAYS),
                creatorId,
                now);
        event.setCapacity(capacity);
        return events.saveAndFlush(event);
    }

    private void goingRow(Event event, long userId) {
        attendance.saveAndFlush(new EventAttendance(event.getId(), userId, AttendanceState.GOING));
    }
}
