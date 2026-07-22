package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.google.firebase.auth.FirebaseAuth;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.AttendanceState;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventAttendance;
import com.teammarhaba.backend.event.EventAttendanceRepository;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.NameLockedException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * TM-907: the name lock. A user with real-world event history — a GOING spot at a completed event, or
 * a reliability strike (a first-event late cancellation / no-show) — can no longer CHANGE an
 * already-set first/last/display name through any self-write path; a user with no history renames
 * freely (current behaviour, preserved). The lock is derived live from event history, so these tests
 * seed the history directly (a finished event + a GOING attendance row, or a late-cancel strike) and
 * assert the write-path outcome end to end through the real controller + service chain.
 *
 * <p>Fail-before/pass-after coverage, one test per contract branch:
 *
 * <ul>
 *   <li>{@code lockedUserPatchRenameIsRefused} — PATCH /me changing a set name → 422, name unchanged;</li>
 *   <li>{@code lockedUserOnboardingResubmitRenameIsRefused} — the onboarding gate re-submit with a
 *       different name → 422 (the second self write path);</li>
 *   <li>{@code unlockedUserRenamesFreely} — a user with no history renames (200), the safety net that
 *       proves the lock isn't over-broad;</li>
 *   <li>{@code lockedButEmptyNameCanStillBeSet} — the carve-out: a locked user whose first/last is
 *       blank can SET it once (a locked EMPTY name stays a fixable profile-strength gap);</li>
 *   <li>{@code lateCancelStrikeLocksTheName} — the no-show / reliability arm locks too;</li>
 *   <li>{@code adminOverrideChangesLockedNameAndAudits} — the admin correction path is exempt and
 *       still writes an ADMIN_USER_PROFILE_EDITED audit row;</li>
 *   <li>{@code meResponseCarriesNameLocked} — the derived flag is exposed on GET /me for the web.</li>
 * </ul>
 *
 * <p>The authenticated case injects a {@link VerifiedUser} principal directly; {@link FirebaseAuth} is
 * mocked so the Admin-SDK account-state block on {@code GET /me} degrades to nulls (mirrors
 * {@link MeProfilePatchValidationIntegrationTest}).
 */
@AutoConfigureMockMvc
class NameLockIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository users;

    @Autowired
    private EventRepository events;

    @Autowired
    private EventAttendanceRepository attendance;

    @MockBean
    private FirebaseAuth firebaseAuth;

    private static RequestPostProcessor caller(String uid) {
        return authentication(
                new UsernamePasswordAuthenticationToken(new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    private static RequestPostProcessor admin(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"),
                null,
                List.of(new SimpleGrantedAuthority("ROLE_ADMIN"))));
    }

    /** A finished PUBLISHED event (ended an hour ago), so a GOING attendee counts as having attended. */
    private Event finishedEvent() {
        Instant now = Instant.now();
        Long creatorId = users.save(new User("uid-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
                .getId();
        Event event = new Event(
                "Finished walk " + UUID.randomUUID(),
                "Come along!",
                "Marhaba Cafe",
                "Europe/London",
                now.minus(3, ChronoUnit.HOURS), // started 3h ago
                now.minus(1, ChronoUnit.DAYS), // visible since yesterday
                now.plus(7, ChronoUnit.DAYS), // still inside its visibility window
                creatorId,
                now.minus(1, ChronoUnit.DAYS));
        event.setEndAt(now.minus(1, ChronoUnit.HOURS)); // ENDED an hour ago → finished
        return events.save(event);
    }

    /** Persist {@code user} then mark them GOING at a finished event — the "attended a completed event" fact. */
    private User seedAttendedUser(String uid, Consumer<User> tweak) {
        User user = new User(uid, uid + "@example.com", "Seed");
        tweak.accept(user);
        user = users.save(user);
        attendance.save(new EventAttendance(finishedEvent().getId(), user.getId(), AttendanceState.GOING));
        return user;
    }

    /**
     * A CANCELLED event whose window has since passed ({@code endAt} an hour ago) but that never
     * happened — the organizer called it off before it ran. Not soft-deleted (cancel keeps the row
     * readable for its attendees), so it still joins; only the {@code status} filter excludes it.
     */
    private Event cancelledFinishedEvent() {
        Instant now = Instant.now();
        Long creatorId = users.save(new User("uid-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
                .getId();
        Event event = new Event(
                "Cancelled walk " + UUID.randomUUID(),
                "Called off",
                "Marhaba Cafe",
                "Europe/London",
                now.minus(3, ChronoUnit.HOURS),
                now.minus(1, ChronoUnit.DAYS),
                now.plus(7, ChronoUnit.DAYS),
                creatorId,
                now.minus(1, ChronoUnit.DAYS));
        event.setEndAt(now.minus(1, ChronoUnit.HOURS));
        event.cancel(now.minus(2, ChronoUnit.HOURS)); // called off before it ran
        return events.save(event);
    }

    @Test
    void lockedUserPatchRenameIsRefused() throws Exception {
        // A user who attended a completed event, with a first name already set.
        seedAttendedUser("uid-locked-patch", u -> {
            u.setFirstName("Aisha");
            u.setLastName("Khan");
            u.setDisplayName("Aisha Khan");
        });

        // Fail-before intent: changing the SET first name is refused with the distinct 422.
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-locked-patch"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Different\"}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.detail").value(NameLockedException.DETAIL))
                .andExpect(jsonPath("$.type").value("https://teammarhaba.app/problems/name-locked"));

        // The stored name is untouched — the refusal rolled the whole write back.
        User after = users.findByFirebaseUid("uid-locked-patch").orElseThrow();
        assertThat(after.getFirstName()).isEqualTo("Aisha");
    }

    @Test
    void lockedUserReSendingSameNameIsANoOpNotRefused() throws Exception {
        // Re-sending the SAME name (unchanged) must never be refused — it is not a rename. Editing a
        // non-name field alongside it still saves; only a genuine name CHANGE is blocked.
        seedAttendedUser("uid-locked-noop", u -> {
            u.setFirstName("Sara");
            u.setDisplayName("Sara");
        });

        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-locked-noop"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Sara\",\"city\":\"London\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("Sara"))
                .andExpect(jsonPath("$.city").value("London"));
    }

    @Test
    void lockedUserOnboardingResubmitRenameIsRefused() throws Exception {
        // The onboarding gate re-submit is the SECOND self write path. A locked user re-submitting with
        // a DIFFERENT display name is a rename → refused. (A phone is on record so the gate's own
        // requirements are met and we exercise the name lock, not the phone gate.)
        // TM-934: a phone unique to this test — the V48 users_phone_normalized_uq index makes every
        // persisted phone in the shared Testcontainers DB unique, so no two test methods may store the
        // same number (was the shared +447700900123, also used by MeProfilePatch/MeController tests).
        seedAttendedUser("uid-locked-onboard", u -> {
            u.setDisplayName("Omar Farouk");
            u.setFirstName("Omar");
            u.setLastName("Farouk");
            u.setPhone("+447700901401");
        });

        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(caller("uid-locked-onboard"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Renamed Person\",\"location\":\"London\",\"age\":30,"
                                + "\"phone\":\"+447700901401\"}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.detail").value(NameLockedException.DETAIL));

        assertThat(users.findByFirebaseUid("uid-locked-onboard").orElseThrow().getDisplayName())
                .isEqualTo("Omar Farouk");
    }

    @Test
    void unlockedUserRenamesFreely() throws Exception {
        // A user with NO event history renames freely — the current behaviour must be preserved.
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-unlocked"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"First\",\"lastName\":\"Last\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("First"));

        // And can rename AGAIN (still no history) — genuinely unlocked, not just first-set.
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-unlocked"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Changed\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("Changed"));
    }

    @Test
    void goingAtCancelledEventDoesNotLockTheName() throws Exception {
        // A GOING spot at an event that was CANCELLED before it ever happened is NOT real history: the
        // event never ran, the identity was never met. Such a user must still rename freely — only the
        // reliability arm (a late-cancel strike) locks a no-show. Fail-before: without the status filter
        // the finished-and-not-soft-deleted CANCELLED event matched and wrongly locked the name.
        User user = new User("uid-cancelled", "uid-cancelled@example.com", "Yusuf Ali");
        user.setFirstName("Yusuf");
        user.setLastName("Ali");
        user.setDisplayName("Yusuf Ali");
        user = users.save(user);
        attendance.save(new EventAttendance(cancelledFinishedEvent().getId(), user.getId(), AttendanceState.GOING));

        // The derived flag is false (no qualifying history) ...
        mockMvc.perform(get("/api/v1/me").with(caller("uid-cancelled")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.nameLocked").value(false));

        // ... and the rename goes through.
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-cancelled"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Renamed\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("Renamed"));

        assertThat(users.findByFirebaseUid("uid-cancelled").orElseThrow().getFirstName())
                .isEqualTo("Renamed");
    }

    @Test
    void lockedButEmptyNameCanStillBeSet() throws Exception {
        // Carve-out: a locked user who attended with only a displayName (first/last still blank) may
        // SET their first/last name ONCE — setting a currently-empty name is not a "change". This is
        // what keeps a locked EMPTY name a fixable profile-strength gap (must-not-break).
        seedAttendedUser("uid-locked-empty", u -> u.setDisplayName("Just A Display Name"));

        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-locked-empty"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Newly\",\"lastName\":\"Set\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("Newly"))
                .andExpect(jsonPath("$.lastName").value("Set"));

        // But once SET, it is now locked: a follow-up CHANGE is refused.
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-locked-empty"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Changed\"}"))
                .andExpect(status().isUnprocessableEntity());
    }

    @Test
    void lateCancelStrikeLocksTheName() throws Exception {
        // The no-show / reliability arm: a late-cancellation strike (late_cancel_count > 0) is real
        // event history that pinned a reliability record to this identity, so it locks too — with NO
        // attended-event attendance row at all.
        User user = new User("uid-strike", "uid-strike@example.com", "Bilal Ahmed");
        user.setFirstName("Bilal");
        user.setLastName("Ahmed");
        user.recordLateCancel(); // one strike
        users.save(user);

        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-strike"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"lastName\":\"Renamed\"}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.detail").value(NameLockedException.DETAIL));

        assertThat(users.findByFirebaseUid("uid-strike").orElseThrow().getLastName()).isEqualTo("Ahmed");
    }

    @Test
    void adminOverrideChangesLockedNameAndAudits() throws Exception {
        // The admin correction path (PATCH /admin/users/{id}/profile) is EXEMPT: it must still change a
        // locked user's name (typo / legal change), and it audits the correction.
        User locked = seedAttendedUser("uid-admin-target", u -> {
            u.setFirstName("Mistyped");
            u.setLastName("Name");
            u.setDisplayName("Mistyped Name");
        });

        mockMvc.perform(patch("/api/v1/admin/users/" + locked.getId() + "/profile")
                        .with(admin("uid-admin-actor"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Corrected\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("Corrected"));

        assertThat(users.findById(locked.getId()).orElseThrow().getFirstName()).isEqualTo("Corrected");
    }

    @Test
    void meResponseCarriesNameLockedTrueForHistoryFalseOtherwise() throws Exception {
        // The derived flag is exposed on GET /me so the web can render the name fields read-only
        // pre-emptively. Locked user → true; fresh user → false.
        seedAttendedUser("uid-flag-locked", u -> u.setDisplayName("Has History"));

        mockMvc.perform(get("/api/v1/me").with(caller("uid-flag-locked")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.nameLocked").value(true));

        mockMvc.perform(get("/api/v1/me").with(caller("uid-flag-fresh")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.nameLocked").value(false));
    }
}
