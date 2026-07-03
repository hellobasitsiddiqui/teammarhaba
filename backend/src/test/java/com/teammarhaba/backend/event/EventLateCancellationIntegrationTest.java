package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.google.firebase.auth.FirebaseAuth;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * End-to-end late-cancellation behaviour against a real Postgres (TM-414): a late un-RSVP increments
 * {@code late_cancel_count} <em>transactionally</em> (the strike is proven by a fresh row re-read, not
 * a mock) and surfaces on {@code GET /api/v1/me}; an early cancel leaves the count untouched and
 * silent; and a {@code preview} dry-run persists nothing. The branch matrix (waitlisted/absent/started,
 * ordinal copy) is covered fast in {@code EventRsvpServiceCancellationTest}.
 */
@AutoConfigureMockMvc
class EventLateCancellationIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private EventRsvpService rsvps;

    @Autowired
    private EventRepository events;

    @Autowired
    private EventAttendanceRepository attendance;

    @Autowired
    private UserRepository users;

    @Autowired
    private MockMvc mockMvc;

    /** Backs the live account-state block on GET /me (TM-164); unstubbed here, it degrades to nulls. */
    @MockBean
    private FirebaseAuth firebaseAuth;

    @Test
    void lateCancelIncrementsCountTransactionallyAndSurfacesOnMe() throws Exception {
        Event event = publishedEventStartingIn(Duration.ofHours(12)); // inside the 24h window
        VerifiedUser caller = newCaller("late");
        rsvps.rsvp(caller, event.getId()); // GOING

        CancelResult result = rsvps.cancelRsvp(caller, event.getId());

        assertThat(result.lateCancel()).isTrue();
        assertThat(result.lateCancelCount()).isEqualTo(1);
        assertThat(result.message()).contains("late cancellation").contains("your 1st");
        // Transactional persistence: the strike is on the row, re-read fresh from the DB.
        assertThat(users.findByFirebaseUid(caller.uid()).orElseThrow().getLateCancelCount())
                .isEqualTo(1);
        // AC4: exposed where the user record is read.
        mockMvc.perform(get("/api/v1/me").with(caller(caller)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.lateCancelCount").value(1));
    }

    @Test
    void earlyCancelDoesNotIncrementAndIsSilent() {
        Event event = publishedEventStartingIn(Duration.ofHours(48)); // outside the 24h window
        VerifiedUser caller = newCaller("early");
        rsvps.rsvp(caller, event.getId());

        CancelResult result = rsvps.cancelRsvp(caller, event.getId());

        assertThat(result.lateCancel()).isFalse();
        assertThat(result.message()).isNull();
        assertThat(users.findByFirebaseUid(caller.uid()).orElseThrow().getLateCancelCount())
                .isZero();
    }

    @Test
    void previewOfALateCancelPersistsNothing() {
        Event event = publishedEventStartingIn(Duration.ofHours(12));
        VerifiedUser caller = newCaller("preview");
        rsvps.rsvp(caller, event.getId());

        CancelResult preview = rsvps.cancelRsvp(caller, event.getId(), true);

        assertThat(preview.preview()).isTrue();
        assertThat(preview.lateCancel()).isTrue();
        assertThat(preview.lateCancelCount()).as("the count it WOULD reach").isEqualTo(1);
        // Nothing written: still GOING, still zero strikes.
        assertThat(attendance
                        .findByEventIdAndUserId(event.getId(), userId(caller))
                        .orElseThrow()
                        .getState())
                .isEqualTo(AttendanceState.GOING);
        assertThat(users.findByFirebaseUid(caller.uid()).orElseThrow().getLateCancelCount())
                .isZero();
    }

    // ------------------------------------------------------------------ fixtures

    /** A PUBLISHED event, visible now, starting {@code untilStart} from now, with room to spare. */
    private Event publishedEventStartingIn(Duration untilStart) {
        Instant now = Instant.now();
        User creator = users.save(new User("uid-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"));
        Event event = new Event(
                "Late cancel test " + UUID.randomUUID(),
                "Cancellation test fixture",
                "Marhaba Cafe",
                "Europe/London",
                now.plus(untilStart),
                now.minus(Duration.ofHours(1)),
                now.plus(Duration.ofDays(30)),
                creator.getId(),
                now);
        event.setCapacity(10);
        return events.save(event);
    }

    private VerifiedUser newCaller(String tag) {
        String uid = "uid-" + tag + "-" + UUID.randomUUID();
        User user = users.save(new User(uid, tag + "@example.com", tag));
        return new VerifiedUser(user.getFirebaseUid(), user.getEmail());
    }

    private Long userId(VerifiedUser caller) {
        return users.findByFirebaseUid(caller.uid()).orElseThrow().getId();
    }

    private static RequestPostProcessor caller(VerifiedUser who) {
        return authentication(new UsernamePasswordAuthenticationToken(who, null, List.of()));
    }
}
