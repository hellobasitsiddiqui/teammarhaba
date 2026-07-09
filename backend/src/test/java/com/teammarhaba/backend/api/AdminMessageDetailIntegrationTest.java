package com.teammarhaba.backend.api;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.messaging.AdminMessageRepository;
import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The admin message <b>by-id detail</b> API ({@code GET /api/v1/admin/messages/{id}}, TM-562, epic
 * TM-432) end-to-end through the real security chain + Postgres. Reuses the recording {@link
 * com.teammarhaba.backend.notify.PushSender} fake from {@link AdminMessageControllerIntegrationTest}
 * (same package) so the send used to seed a campaign never hits real FCM. Covers the ACs:
 *
 * <ul>
 *   <li><b>returns the body for the sender</b> — the detail carries the full message {@code body} (the
 *       thing the header-only sent-history list omits) plus the header facts, for the campaign's own sender;
 *   <li><b>scoped 404</b> — an unknown id, and another admin's message, are both a uniform 404 (no leak);
 *   <li><b>admin-gated</b> — anonymous → 401, USER → 403.
 * </ul>
 */
@AutoConfigureMockMvc
@Import(AdminMessageControllerIntegrationTest.RecordingSenderConfig.class)
class AdminMessageDetailIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository users;

    @Autowired
    private AdminMessageRepository adminMessages;

    // --- principals --------------------------------------------------------------------------------

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

    // --- seeding -----------------------------------------------------------------------------------

    private long seedUser(String uid) {
        User u = new User(uid, uid + "@example.com", uid);
        u.setNotificationPref(NotificationPref.PUSH);
        return users.saveAndFlush(u).getId();
    }

    private static String userBody(List<Long> ids, String title, String body, String deepLink) {
        String csv = ids.stream().map(String::valueOf).reduce((a, b) -> a + "," + b).orElse("");
        String dl = deepLink == null ? "" : ",\"deepLink\":\"" + deepLink + "\"";
        return "{\"title\":\"" + title + "\",\"body\":\"" + body + "\",\"userIds\":[" + csv + "]" + dl + "}";
    }

    /** Send a message from {@code adminUid} to {@code recipients} via the real endpoint; return its id. */
    private long send(String adminUid, List<Long> recipients, String title, String body, String deepLink)
            throws Exception {
        mockMvc.perform(post("/api/v1/admin/messages")
                        .with(admin(adminUid))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(userBody(recipients, title, body, deepLink)))
                .andExpect(status().isOk());
        return adminMessages.findByActorUidOrderByCreatedAtDesc(adminUid).get(0).getId();
    }

    // --- the happy path: the sender gets the full body + header facts ------------------------------

    @Test
    void detailReturnsTheBodyAndHeaderFactsForTheSender() throws Exception {
        long target = seedUser("detail-target");
        long id = send("admin-detail", List.of(target), "Venue changed", "We moved to Marhaba Cafe, 7pm.", "#/home");

        mockMvc.perform(get("/api/v1/admin/messages/" + id).with(admin("admin-detail")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.id").value((int) id))
                // The point of TM-562: the full body the header-only list read omits.
                .andExpect(jsonPath("$.body").value("We moved to Marhaba Cafe, 7pm."))
                // ...alongside the same header facts the list row carries.
                .andExpect(jsonPath("$.title").value("Venue changed"))
                .andExpect(jsonPath("$.sentByUid").value("admin-detail"))
                .andExpect(jsonPath("$.audienceType").value("USER"))
                .andExpect(jsonPath("$.recipientCount").value(1))
                .andExpect(jsonPath("$.deepLink").value("#/home"))
                .andExpect(jsonPath("$.status").value("SENT"))
                .andExpect(jsonPath("$.sentAt").isNotEmpty());
    }

    @Test
    void detailCarriesTheWholeLongBody() throws Exception {
        long target = seedUser("detail-long");
        String longBody = "z".repeat(AdminMessageRequest.MAX_BODY_LENGTH); // 5000 chars — the cap
        long id = send("admin-long", List.of(target), "Long one", longBody, null);

        mockMvc.perform(get("/api/v1/admin/messages/" + id).with(admin("admin-long")))
                .andExpect(status().isOk())
                // The detail read returns the WHOLE stored body, not a preview.
                .andExpect(jsonPath("$.body").value(longBody))
                .andExpect(jsonPath("$.deepLink").isEmpty()); // null deep-link stays null
    }

    // --- scoped 404 (unknown id / another admin's message) -----------------------------------------

    @Test
    void unknownIdIs404() throws Exception {
        mockMvc.perform(get("/api/v1/admin/messages/999999").with(admin("admin-404")))
                .andExpect(status().isNotFound())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Resource not found"));
    }

    @Test
    void anotherAdminsMessageIs404() throws Exception {
        long target = seedUser("scoped-detail-target");
        long id = send("admin-owner", List.of(target), "Private", "Only the owner should read this.", null);

        // A different admin can't read a message they didn't send — a uniform 404 (never leaks it exists,
        // and crucially never leaks the body).
        mockMvc.perform(get("/api/v1/admin/messages/" + id).with(admin("admin-other")))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.title").value("Resource not found"));
    }

    // --- admin gate --------------------------------------------------------------------------------

    @Test
    void anonymousGetsUniform401() throws Exception {
        long id = send("admin-gate", List.of(seedUser("gate-detail-target")), "Hi", "There", null);

        mockMvc.perform(get("/api/v1/admin/messages/" + id))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Unauthorized"));
    }

    @Test
    void nonAdminGets403() throws Exception {
        long id = send("admin-gate2", List.of(seedUser("nonadmin-detail-target")), "Hi", "There", null);

        mockMvc.perform(get("/api/v1/admin/messages/" + id).with(regularUser("plain-user")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.title").value("Forbidden"))
                .andExpect(jsonPath("$.status").value(403));
    }
}
