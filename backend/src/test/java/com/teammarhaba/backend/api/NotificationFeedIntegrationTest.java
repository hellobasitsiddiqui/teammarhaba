package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.notify.Notification;
import com.teammarhaba.backend.notify.NotificationRepository;
import com.teammarhaba.backend.notify.NotificationType;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The notification feed API contract over real HTTP + Postgres (TM-454). Exercises the admin/system
 * half of the bell end to end against the notification store (TM-452): the feed is newest-first,
 * paged, and caller-scoped; the badge reports unseen (bell) + unread; opening the bell (mark-seen)
 * clears the badge without touching unread; tapping an item (mark-read) marks that one read (and
 * back-fills seen), is idempotent, and is owner-scoped (a foreign id 404s); and every route
 * default-denies an anonymous caller.
 *
 * <p>Rows are inserted <b>straight through the repository</b> — deliberately not through the writer
 * paths (TM-441 / TM-453), which build in parallel — so this suite validates the read/clear API in
 * isolation. Every scenario uses a freshly-provisioned user (unique uid) so the shared integration
 * context's accumulated rows never skew a user-scoped count or feed.
 */
@AutoConfigureMockMvc
class NotificationFeedIntegrationTest extends AbstractIntegrationTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private NotificationRepository notifications;

    @Autowired
    private UserRepository users;

    // ------------------------------------------------------------------ feed: order, scope, paging

    @Test
    void feedIsNewestFirstScopedToCallerAndPaged() throws Exception {
        String uid = "notif-feed-" + UUID.randomUUID();
        Long userId = newUser(uid);
        Long otherId = newUser("notif-feed-other-" + UUID.randomUUID());

        // Each save autocommits in its own transaction → distinct DB now() + monotonic id, so the feed
        // orders by created_at DESC, id DESC (newest first). Insert order: first, second, third.
        Long first = save(userId, NotificationType.RSVP_CONFIRMED, "First");
        Long second = save(userId, NotificationType.EVENT_UPDATED, "Second");
        Long third = save(userId, NotificationType.ADMIN_MESSAGE, "Third");
        // A different user's notification must never leak into this caller's feed.
        save(otherId, NotificationType.ADMIN_MESSAGE, "Other");

        // Page 0, size 2: the newest two, newest first, with total metadata spanning all three.
        JsonNode page0 = getJson("/api/v1/me/notifications?size=2", caller(uid));
        assertThat(ids(page0)).containsExactly(third, second);
        assertThat(page0.get("page").asInt()).isEqualTo(0);
        assertThat(page0.get("size").asInt()).isEqualTo(2);
        assertThat(page0.get("totalElements").asLong()).isEqualTo(3);
        assertThat(page0.get("totalPages").asInt()).isEqualTo(2);

        // Page 1 carries the remaining oldest one.
        JsonNode page1 = getJson("/api/v1/me/notifications?size=2&page=1", caller(uid));
        assertThat(ids(page1)).containsExactly(first);

        // The DTO surfaces the fields the panel renders, incl. the derived seen/read flags.
        JsonNode newest = page0.get("items").get(0);
        assertThat(newest.get("type").asText()).isEqualTo("ADMIN_MESSAGE");
        assertThat(newest.get("title").asText()).isEqualTo("Third");
        assertThat(newest.get("seen").asBoolean()).isFalse();
        assertThat(newest.get("read").asBoolean()).isFalse();
    }

    // ------------------------------------------------------------------ badge counts

    @Test
    void badgeReportsUnseenAndUnread() throws Exception {
        String uid = "notif-badge-" + UUID.randomUUID();
        Long userId = newUser(uid);
        save(userId, NotificationType.ADMIN_MESSAGE, "A");
        save(userId, NotificationType.ADMIN_MESSAGE, "B");
        save(userId, NotificationType.ADMIN_MESSAGE, "C");

        // All three start unseen and unread.
        JsonNode badge = getJson("/api/v1/me/notifications/badge", caller(uid));
        assertThat(badge.get("unseen").asLong()).isEqualTo(3);
        assertThat(badge.get("unread").asLong()).isEqualTo(3);
    }

    // ------------------------------------------------------------------ mark-seen clears the badge

    @Test
    void markSeenClearsTheBadgeButNotUnread() throws Exception {
        String uid = "notif-seen-" + UUID.randomUUID();
        Long userId = newUser(uid);
        save(userId, NotificationType.ADMIN_MESSAGE, "A");
        save(userId, NotificationType.EVENT_REMINDER, "B");

        // Opening the bell returns the refreshed counts: unseen drops to 0, unread is untouched
        // (seeing the list is not reading the items).
        JsonNode afterSeen = postJson("/api/v1/me/notifications/seen", caller(uid));
        assertThat(afterSeen.get("unseen").asLong()).isZero();
        assertThat(afterSeen.get("unread").asLong()).isEqualTo(2);

        // ...and a follow-up GET agrees (the state was persisted, not just reported).
        JsonNode badge = getJson("/api/v1/me/notifications/badge", caller(uid));
        assertThat(badge.get("unseen").asLong()).isZero();
        assertThat(badge.get("unread").asLong()).isEqualTo(2);

        // The feed now shows every row as seen-but-unread.
        JsonNode feed = getJson("/api/v1/me/notifications", caller(uid));
        for (JsonNode item : feed.get("items")) {
            assertThat(item.get("seen").asBoolean()).isTrue();
            assertThat(item.get("read").asBoolean()).isFalse();
        }
    }

    // ------------------------------------------------------------------ mark-read per item

    @Test
    void markReadMarksItemReadBackfillsSeenAndIsIdempotent() throws Exception {
        String uid = "notif-read-" + UUID.randomUUID();
        Long userId = newUser(uid);
        Long a = save(userId, NotificationType.ADMIN_MESSAGE, "A");
        save(userId, NotificationType.ADMIN_MESSAGE, "B");

        // Tapping A marks it read and back-fills seen (read implies seen); the returned row reflects it.
        JsonNode read = postJson("/api/v1/me/notifications/" + a + "/read", caller(uid));
        assertThat(read.get("id").asLong()).isEqualTo(a);
        assertThat(read.get("read").asBoolean()).isTrue();
        assertThat(read.get("seen").asBoolean()).isTrue();

        // Only A moved: unread drops to 1 (B still unread), unseen to 1 (B still unseen).
        JsonNode badge = getJson("/api/v1/me/notifications/badge", caller(uid));
        assertThat(badge.get("unread").asLong()).isEqualTo(1);
        assertThat(badge.get("unseen").asLong()).isEqualTo(1);

        // A re-tap is a no-op (one-way, idempotent) — still 200, still read, counts unchanged.
        postJson("/api/v1/me/notifications/" + a + "/read", caller(uid));
        JsonNode after = getJson("/api/v1/me/notifications/badge", caller(uid));
        assertThat(after.get("unread").asLong()).isEqualTo(1);
        assertThat(after.get("unseen").asLong()).isEqualTo(1);
    }

    @Test
    void markReadOfAnotherUsersNotificationIsNotFound() throws Exception {
        String uid = "notif-own-" + UUID.randomUUID();
        newUser(uid);
        Long otherId = newUser("notif-own-other-" + UUID.randomUUID());
        Long foreign = save(otherId, NotificationType.ADMIN_MESSAGE, "Not yours");

        // The caller may not mark-read a notification they don't own — indistinguishable from missing.
        mockMvc.perform(post("/api/v1/me/notifications/" + foreign + "/read").with(caller(uid)))
                .andExpect(status().isNotFound());
        // A genuinely unknown id is the same 404.
        mockMvc.perform(post("/api/v1/me/notifications/99999999/read").with(caller(uid)))
                .andExpect(status().isNotFound());
    }

    // ------------------------------------------------------------------ default-deny

    @Test
    void everyRouteRequiresAuthentication() throws Exception {
        mockMvc.perform(get("/api/v1/me/notifications")).andExpect(status().isUnauthorized());
        mockMvc.perform(get("/api/v1/me/notifications/badge")).andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/me/notifications/seen")).andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/me/notifications/1/read")).andExpect(status().isUnauthorized());
    }

    // ------------------------------------------------------------------ fixtures

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    private Long newUser(String uid) {
        return users.save(new User(uid, uid + "@example.com", uid)).getId();
    }

    private Long save(Long userId, NotificationType type, String title) {
        return notifications.save(new Notification(userId, type, title, title + " body", null, null)).getId();
    }

    private JsonNode getJson(String url, RequestPostProcessor caller) throws Exception {
        String body = mockMvc.perform(get(url).with(caller))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        return JSON.readTree(body);
    }

    private JsonNode postJson(String url, RequestPostProcessor caller) throws Exception {
        String body = mockMvc.perform(post(url).with(caller))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        return JSON.readTree(body);
    }

    private static List<Long> ids(JsonNode page) {
        List<Long> out = new java.util.ArrayList<>();
        for (JsonNode item : page.get("items")) {
            out.add(item.get("id").asLong());
        }
        return out;
    }
}
