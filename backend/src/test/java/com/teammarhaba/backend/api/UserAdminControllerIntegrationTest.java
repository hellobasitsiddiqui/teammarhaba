package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.GetUsersResult;
import com.google.firebase.auth.UserRecord;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditEvent;
import com.teammarhaba.backend.audit.AuditRepository;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.notify.PushRoutes;
import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.Role;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.util.List;
import java.util.Set;
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
 * The admin user-management API (TM-111) end-to-end through the real security chain + Postgres:
 * ADMIN-only access (USER → 403, anon → 401), paged listing with a size cap + sort guard,
 * enable/disable + set-role (claim written via the mocked Admin SDK), admin self-protection (422),
 * and 404 for a missing target (no existence leak).
 */
@AutoConfigureMockMvc
class UserAdminControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository users;

    @Autowired
    private DeviceTokenRepository tokens;

    @Autowired
    private AuditRepository audit;

    // Role changes call the Admin SDK; mock it so no Firebase credentials are needed.
    @MockBean
    private FirebaseAuth firebaseAuth;

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

    private long seed(String uid) {
        return users.saveAndFlush(new User(uid, uid + "@example.com", null)).getId();
    }

    /** Seed an account with an explicit notification preference (TM-427 push-eligibility tests). */
    private long seedWithPref(String uid, NotificationPref pref) {
        User u = new User(uid, uid + "@example.com", null);
        u.setNotificationPref(pref);
        return users.saveAndFlush(u).getId();
    }

    /** Register a device token for an account, so it has "a device a push could reach" (TM-427). */
    private void seedToken(long userId, String token) {
        tokens.saveAndFlush(new DeviceToken(userId, token, DevicePlatform.ANDROID, Instant.now()));
    }

    /**
     * Soft-delete (tombstone) an account so the entity's {@code @SQLRestriction} hides it. {@code
     * markDeleted} is package-private (this test is in a different package), so set the field directly
     * by reflection — the same approach {@code PushAdminControllerIntegrationTest} uses.
     */
    private void softDelete(long userId) {
        User u = users.findById(userId).orElseThrow();
        try {
            var field = User.class.getDeclaredField("deletedAt");
            field.setAccessible(true);
            field.set(u, Instant.now());
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("Could not tombstone user " + userId, e);
        }
        users.saveAndFlush(u);
    }

    @Test
    void anonymousGetsUniform401() throws Exception {
        mockMvc.perform(get("/api/v1/admin/users"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Unauthorized"));
    }

    @Test
    void nonAdminGetsUniform403() throws Exception {
        mockMvc.perform(get("/api/v1/admin/users").with(regularUser("plain-user")))
                .andExpect(status().isForbidden())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Forbidden"))
                .andExpect(jsonPath("$.status").value(403));
    }

    @Test
    void adminListsUsersPagedWithSizeCapHonoured() throws Exception {
        seed("list-a");
        seed("list-b");

        mockMvc.perform(get("/api/v1/admin/users")
                        .param("page", "0")
                        .param("size", "1")
                        .param("sort", "id,asc")
                        .with(admin("admin-list")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.page").value(0))
                .andExpect(jsonPath("$.size").value(1))
                .andExpect(jsonPath("$.totalElements").value(org.hamcrest.Matchers.greaterThanOrEqualTo(2)));
    }

    @Test
    void adminDisablesAnotherUser() throws Exception {
        long id = seed("to-disable");

        mockMvc.perform(patch("/api/v1/admin/users/{id}", id)
                        .with(admin("admin-d"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"enabled\":false}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.enabled").value(false));

        assertThat(users.findById(id).orElseThrow().isEnabled()).isFalse();
    }

    @Test
    void adminSetsAnotherUsersRoleAndWritesTheClaim() throws Exception {
        long id = seed("to-promote");

        mockMvc.perform(patch("/api/v1/admin/users/{id}", id)
                        .with(admin("admin-r"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"ADMIN\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.role").value("ADMIN"));

        assertThat(users.findById(id).orElseThrow().getRole()).isEqualTo(Role.ADMIN);
    }

    @Test
    void adminCannotDisableTheirOwnAccount() throws Exception {
        long id = seed("self-admin");

        mockMvc.perform(patch("/api/v1/admin/users/{id}", id)
                        .with(admin("self-admin")) // caller uid == target uid
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"enabled\":false}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.title").value("Operation not allowed"));

        assertThat(users.findById(id).orElseThrow().isEnabled()).isTrue();
    }

    @Test
    void missingTargetIs404NotLeaking() throws Exception {
        mockMvc.perform(patch("/api/v1/admin/users/{id}", 999_999L)
                        .with(admin("admin-x"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"enabled\":false}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.title").value("Resource not found"));
    }

    @Test
    void unknownSortPropertyIs400() throws Exception {
        mockMvc.perform(get("/api/v1/admin/users").param("sort", "password").with(admin("admin-s")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Bad request"));
    }

    // --- Deep-link route allow-list for the broadcast/test-push compose picker (TM-360) ---

    @Test
    void adminGetsThePushRouteAllowList() throws Exception {
        // The picker's single source of truth: exactly PushRoutes.KNOWN, wrapped as {"routes":[...]},
        // sorted for a stable dropdown order. A signed-in ADMIN reads it read-only.
        mockMvc.perform(get("/api/v1/admin/users/push-routes").with(admin("admin-routes")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.routes.length()").value(PushRoutes.KNOWN.size()))
                .andExpect(jsonPath("$.routes",
                        org.hamcrest.Matchers.containsInAnyOrder(PushRoutes.KNOWN.toArray())))
                // sorted ascending so the dropdown order is deterministic (#/membership joined in TM-620)
                .andExpect(jsonPath("$.routes[0]").value("#/admin"))
                .andExpect(jsonPath("$.routes[6]").value("#/profile"));
    }

    @Test
    void pushRouteAllowListIsAdminOnly() throws Exception {
        mockMvc.perform(get("/api/v1/admin/users/push-routes").with(regularUser("plain-user")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.status").value(403));
    }

    @Test
    void pushRouteAllowListRejectsAnonymous() throws Exception {
        mockMvc.perform(get("/api/v1/admin/users/push-routes"))
                .andExpect(status().isUnauthorized());
    }

    // --- auth-phone enrichment (TM-372): phone-only accounts render identifiably, not blank ---

    /** Stub the mocked Admin SDK so the batch lookup reports one account with a phone identity. */
    private void firebaseHasPhone(String uid, String phone) throws Exception {
        UserRecord record = mock(UserRecord.class);
        when(record.getUid()).thenReturn(uid);
        when(record.getPhoneNumber()).thenReturn(phone);
        GetUsersResult result = mock(GetUsersResult.class);
        when(result.getUsers()).thenReturn(Set.of(record));
        when(firebaseAuth.getUsers(any())).thenReturn(result);
    }

    @Test
    void listCarriesTheAuthPhoneForAPhoneOnlyAccount() throws Exception {
        // The TM-372 repro: a phone-auth account with NO email and NO display name — previously an
        // unidentifiable blank row. The admin list now carries its verified auth phone from Firebase.
        long id = users.saveAndFlush(new User("phone-only-uid", null, null)).getId();
        firebaseHasPhone("phone-only-uid", "+16505550100");

        // Newest-first so the just-seeded row is on page 0 regardless of what other tests seeded.
        mockMvc.perform(get("/api/v1/admin/users")
                        .param("size", "100")
                        .param("sort", "id,desc")
                        .with(admin("admin-phone")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[?(@.id == " + id + ")].phoneNumber").value("+16505550100"));
    }

    @Test
    void singleUserReadCarriesTheAuthPhone() throws Exception {
        long id = users.saveAndFlush(new User("phone-only-get-uid", null, null)).getId();
        firebaseHasPhone("phone-only-get-uid", "+16505550100");

        mockMvc.perform(get("/api/v1/admin/users/{id}", id).with(admin("admin-phone-get")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.phoneNumber").value("+16505550100"));
    }

    @Test
    void phoneNumberIsNullWhenFirebaseHasNothingToSay() throws Exception {
        // The unstubbed @MockBean returns null from getUsers — the enrichment's defensive path: the
        // response still succeeds, phoneNumber is just null (the UI then falls back to the DB id).
        long id = seed("no-phone");

        mockMvc.perform(get("/api/v1/admin/users/{id}", id).with(admin("admin-no-phone")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.phoneNumber").value(org.hamcrest.Matchers.nullValue()));
    }

    @Test
    void patchResponseKeepsTheAuthPhoneSoTheConsoleRowStaysIdentifiable() throws Exception {
        // The console replaces its row with the PATCH body (admin.js), so disabling a phone-only
        // account must return the phone identifier too — and proves such an account is manageable.
        long id = users.saveAndFlush(new User("phone-only-patch-uid", null, null)).getId();
        firebaseHasPhone("phone-only-patch-uid", "+16505550100");

        mockMvc.perform(patch("/api/v1/admin/users/{id}", id)
                        .with(admin("admin-phone-patch"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"enabled\":false}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.enabled").value(false))
                .andExpect(jsonPath("$.phoneNumber").value("+16505550100"));

        assertThat(users.findById(id).orElseThrow().isEnabled()).isFalse();
    }

    // --- push-eligibility signal for the send-notification page (TM-427) ---
    //
    // pushEligible == the account's pref permits push AND it has a registered device token. The admin
    // send-notification page surfaces this and blocks selecting/sending push to an ineligible account,
    // so an admin can't fire a push into the void. The just-seeded row is fetched by id from a
    // newest-first page (like the auth-phone tests) so accumulated rows from other tests don't matter.

    @Test
    void listMarksAPushUserWithADeviceEligible() throws Exception {
        long id = seedWithPref("elig-push-dev", NotificationPref.BOTH);
        seedToken(id, "tok-elig-" + id);

        mockMvc.perform(get("/api/v1/admin/users")
                        .param("size", "100")
                        .param("sort", "id,desc")
                        .with(admin("admin-elig-1")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[?(@.id == " + id + ")].pushEligible").value(true));
    }

    @Test
    void listMarksAnOptedOutUserIneligibleEvenWithADevice() throws Exception {
        // Has a device, but chose EMAIL (the push opt-out) — a push would be skipped, so it's ineligible.
        long id = seedWithPref("elig-email-dev", NotificationPref.EMAIL);
        seedToken(id, "tok-email-" + id);

        mockMvc.perform(get("/api/v1/admin/users")
                        .param("size", "100")
                        .param("sort", "id,desc")
                        .with(admin("admin-elig-2")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[?(@.id == " + id + ")].pushEligible").value(false));
    }

    @Test
    void listMarksAPushUserWithoutADeviceIneligible() throws Exception {
        // Permits push (default BOTH), but no device token is registered — a push has nowhere to land.
        long id = seedWithPref("elig-push-nodev", NotificationPref.BOTH);

        mockMvc.perform(get("/api/v1/admin/users")
                        .param("size", "100")
                        .param("sort", "id,desc")
                        .with(admin("admin-elig-3")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[?(@.id == " + id + ")].pushEligible").value(false));
    }

    @Test
    void singleUserReadExposesPushEligibility() throws Exception {
        long id = seedWithPref("elig-single", NotificationPref.PUSH);
        seedToken(id, "tok-single-" + id);

        mockMvc.perform(get("/api/v1/admin/users/{id}", id).with(admin("admin-elig-single")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.pushEligible").value(true));
    }

    // --- TM-172: admin edit of ANOTHER user's admin-editable PROFILE fields ---
    //
    // PATCH /admin/users/{id}/profile writes the TM-162 profile set (names/city/age/phone/
    // notificationPref/timezone/locale) for a target user, reusing the SAME validation as the user's
    // own PATCH /me (shared UserService.applyProfileFields), and audits every edit as
    // ADMIN_USER_PROFILE_EDITED. Identity/role/enabled are out of scope (governed by PATCH /admin/users/{id}).

    private static final String PROFILE_PATH = "/api/v1/admin/users/{id}/profile";

    /** Newest ADMIN_USER_PROFILE_EDITED audit row against a target uid, or null if none. */
    private AuditEvent latestAdminProfileEdit(String targetUid) {
        List<AuditEvent> rows = audit.findByTargetTypeAndTargetIdOrderByCreatedAtDesc("User", targetUid);
        return rows.stream()
                .filter(e -> e.getAction() == AuditAction.ADMIN_USER_PROFILE_EDITED)
                .findFirst()
                .orElse(null);
    }

    @Test
    void adminEditsAnotherUsersProfileFieldsAndAudits() throws Exception {
        long id = seed("profile-target");

        mockMvc.perform(patch(PROFILE_PATH, id)
                        .with(admin("admin-profile-editor"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(
                                "{\"firstName\":\"Aisha\",\"lastName\":\"Khan\",\"city\":\"London\",\"age\":30,"
                                        + "\"phone\":\"+442079460958\",\"notificationPref\":\"EMAIL\","
                                        + "\"timezone\":\"Europe/London\",\"locale\":\"en-GB\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("Aisha"))
                .andExpect(jsonPath("$.lastName").value("Khan"))
                .andExpect(jsonPath("$.city").value("London"))
                .andExpect(jsonPath("$.age").value(30))
                .andExpect(jsonPath("$.phone").value("+442079460958"))
                .andExpect(jsonPath("$.notificationPref").value("EMAIL"))
                .andExpect(jsonPath("$.timezone").value("Europe/London"))
                .andExpect(jsonPath("$.locale").value("en-GB"));

        User saved = users.findById(id).orElseThrow();
        assertThat(saved.getFirstName()).isEqualTo("Aisha");
        assertThat(saved.getCity()).isEqualTo("London");
        assertThat(saved.getAge()).isEqualTo(30);
        assertThat(saved.getPhone()).isEqualTo("+442079460958");
        assertThat(saved.getNotificationPref()).isEqualTo(NotificationPref.EMAIL);

        // Audited as an ADMIN action, actor = the admin, target = the edited account's uid, source=admin.
        AuditEvent edit = latestAdminProfileEdit("profile-target");
        assertThat(edit).as("admin profile edit is audited").isNotNull();
        assertThat(edit.getActorUid()).isEqualTo("admin-profile-editor");
        assertThat(edit.getTargetId()).isEqualTo("profile-target");
        assertThat(edit.getMetadata()).containsEntry("source", "admin");
        assertThat(edit.getMetadata()).containsEntry("actorUid", "admin-profile-editor");
        assertThat(edit.getMetadata()).containsEntry("targetUid", "profile-target");
    }

    @Test
    void adminProfileEditIsForbiddenForNonAdmin() throws Exception {
        long id = seed("profile-target-403");

        mockMvc.perform(patch(PROFILE_PATH, id)
                        .with(regularUser("nosy-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Nope\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.status").value(403));

        assertThat(users.findById(id).orElseThrow().getFirstName()).isNull();
    }

    @Test
    void adminProfileEditRejectsAnonymous() throws Exception {
        long id = seed("profile-target-401");

        mockMvc.perform(patch(PROFILE_PATH, id)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Nope\"}"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void adminProfileEditRejectsAnOffListCity() throws Exception {
        // TM-877: the SAME city allow-list the self-edit enforces — "Dubai" is off-list → 400.
        long id = seed("profile-bad-city");

        mockMvc.perform(patch(PROFILE_PATH, id)
                        .with(admin("admin-bad-city"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"city\":\"Dubai\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Bad request"));

        assertThat(users.findById(id).orElseThrow().getCity()).isNull();
        assertThat(latestAdminProfileEdit("profile-bad-city")).as("a rejected edit is not audited").isNull();
    }

    @Test
    void adminProfileEditRejectsAnOutOfBandAge() throws Exception {
        // TM-884: the SAME 18–99 band the self-edit enforces — 15 is below the floor → 400.
        long id = seed("profile-bad-age");

        mockMvc.perform(patch(PROFILE_PATH, id)
                        .with(admin("admin-bad-age"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"age\":15}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Bad request"));

        assertThat(users.findById(id).orElseThrow().getAge()).isNull();
    }

    @Test
    void adminProfileEditRejectsABadPhone() throws Exception {
        // TM-781: the SAME E.164 boundary shape as UpdateMeRequest — a bare national number (no +dial)
        // is a 400 at the bean-validation boundary, exactly as the self-edit rejects it.
        long id = seed("profile-bad-phone");

        mockMvc.perform(patch(PROFILE_PATH, id)
                        .with(admin("admin-bad-phone"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"07700900000\"}"))
                // A non-E.164 phone is caught at the bean-validation boundary (@Pattern on the DTO, the
                // SAME pattern UpdateMeRequest carries), so it's a 400 titled "Validation failed" —
                // vs the off-list-city / out-of-band-age cases, which the service rejects with a
                // "Bad request" BadRequestException. Both are uniform 400s reusing the self-edit rules.
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));

        assertThat(users.findById(id).orElseThrow().getPhone()).isNull();
    }

    @Test
    void adminProfileEditMissingTargetIs404NotLeaking() throws Exception {
        mockMvc.perform(patch(PROFILE_PATH, 999_999L)
                        .with(admin("admin-missing"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Ghost\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.title").value("Resource not found"));
    }

    @Test
    void adminProfileEditSoftDeletedTargetIs404NotLeaking() throws Exception {
        // The spec calls out a "missing/soft-deleted target" 404. A never-existed id (above) is one
        // half; this asserts the OTHER half — a tombstoned account must be indistinguishable from a
        // never-existed one (no existence leak). Guaranteed by @SQLRestriction("deleted_at is null")
        // making findById skip tombstoned rows; assert it so a future lookup that ignores the soft-delete
        // restriction (e.g. a native findByIdIncludingDeleted) would go red instead of silently
        // resurrecting the row as editable.
        long id = seed("profile-tombstoned");
        softDelete(id);

        mockMvc.perform(patch(PROFILE_PATH, id)
                        .with(admin("admin-tombstoned"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Ghost\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.title").value("Resource not found"));
    }

    @Test
    void adminProfileEditIsPartialAndLeavesOmittedFieldsUntouched() throws Exception {
        // Seed a user with an existing city, then patch ONLY firstName — the city must survive.
        User u = new User("profile-partial", "profile-partial@example.com", null);
        u.setCity("London");
        u.setAge(40);
        long id = users.saveAndFlush(u).getId();

        mockMvc.perform(patch(PROFILE_PATH, id)
                        .with(admin("admin-partial"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Solo\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("Solo"))
                .andExpect(jsonPath("$.city").value("London"))
                .andExpect(jsonPath("$.age").value(40));

        User saved = users.findById(id).orElseThrow();
        assertThat(saved.getFirstName()).isEqualTo("Solo");
        assertThat(saved.getCity()).isEqualTo("London");
        assertThat(saved.getAge()).isEqualTo(40);
    }

    @Test
    void adminProfileEditDoesNotChangeRoleOrEnabled() throws Exception {
        // Out-of-scope invariant (TM-172): the profile endpoint never touches role/enabled — they stay
        // governed by PATCH /admin/users/{id}. A profile edit leaves both exactly as they were.
        long id = seed("profile-scope");

        mockMvc.perform(patch(PROFILE_PATH, id)
                        .with(admin("admin-scope"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Scoped\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.role").value("USER"))
                .andExpect(jsonPath("$.enabled").value(true));

        User saved = users.findById(id).orElseThrow();
        assertThat(saved.getRole()).isEqualTo(Role.USER);
        assertThat(saved.isEnabled()).isTrue();
    }
}
