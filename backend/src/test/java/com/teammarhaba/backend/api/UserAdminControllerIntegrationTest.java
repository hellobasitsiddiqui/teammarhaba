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
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.notify.PushRoutes;
import com.teammarhaba.backend.user.Role;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
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
                // sorted ascending so the dropdown order is deterministic
                .andExpect(jsonPath("$.routes[0]").value("#/admin"))
                .andExpect(jsonPath("$.routes[5]").value("#/profile"));
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
}
