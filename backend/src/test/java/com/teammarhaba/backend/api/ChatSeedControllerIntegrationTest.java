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
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The TM-587 chat seed endpoint end to end over real HTTP + Postgres — the CI-safe way to populate a
 * test user's chat so the Event Chat foundation screens render against a LIVE backend (not the
 * TM-564 route mocks). Enabled here because the {@code test} profile sets {@code
 * app.test-seed.enabled=true}; the prod-disabled guard is the sibling {@link
 * ChatSeedDisabledIntegrationTest}.
 *
 * <p>Asserts the acceptance criteria: one authenticated {@code POST /api/v1/test/chat/seed} creates
 * the expected threads (two event group chats + one admin "from TeamMarhaba" channel) with messages
 * and unread state, those threads then render through the real read API ({@code GET
 * /api/v1/me/conversations}) with derived titles + per-caller unread counts, and a re-seed is an
 * idempotent no-op (no duplicate threads). Every scenario uses a fresh, uniquely-named caller so the
 * shared integration context can't skew a caller-scoped count; an {@code @AfterEach} removes this
 * test's rows (the shared seeded "other member" users are left — they're idempotent and harmless).
 */
@AutoConfigureMockMvc
class ChatSeedControllerIntegrationTest extends AbstractIntegrationTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SEED_URL = "/api/v1/test/chat/seed";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbc;

    /** Callers created by this test, so the @AfterEach can remove exactly their rows. */
    private final List<String> callerUids = new ArrayList<>();

    @AfterEach
    void leaveNoResidue() {
        // Child-first, caller-scoped cleanup: the caller's event threads (via their events), their
        // admin channel (owner_user_id), and the caller row itself. The shared "tm587-seed-*" member
        // users persist (idempotent across runs). event_attendance is untouched: the seed drives the
        // chat lifecycle hook directly, so it never writes an attendance row.
        for (String uid : callerUids) {
            jdbc.update(
                    "DELETE FROM message WHERE conversation_id IN (SELECT c.id FROM conversation c"
                            + " LEFT JOIN events e ON c.event_id = e.id"
                            + " WHERE e.created_by IN (SELECT id FROM users WHERE firebase_uid = ?)"
                            + " OR c.owner_user_id IN (SELECT id FROM users WHERE firebase_uid = ?))",
                    uid, uid);
            jdbc.update(
                    "DELETE FROM conversation_member WHERE conversation_id IN (SELECT c.id FROM conversation c"
                            + " LEFT JOIN events e ON c.event_id = e.id"
                            + " WHERE e.created_by IN (SELECT id FROM users WHERE firebase_uid = ?)"
                            + " OR c.owner_user_id IN (SELECT id FROM users WHERE firebase_uid = ?))",
                    uid, uid);
            jdbc.update(
                    "DELETE FROM conversation WHERE owner_user_id IN (SELECT id FROM users WHERE firebase_uid = ?)"
                            + " OR event_id IN (SELECT id FROM events WHERE created_by IN"
                            + " (SELECT id FROM users WHERE firebase_uid = ?))",
                    uid, uid);
            jdbc.update(
                    "DELETE FROM events WHERE created_by IN (SELECT id FROM users WHERE firebase_uid = ?)", uid);
            jdbc.update("DELETE FROM users WHERE firebase_uid = ?", uid);
        }
        // Remove the shared seeded "other member" users too (leave zero residue) — safe now that every
        // caller's messages that referenced them (message.sender_id FK) have been deleted above.
        jdbc.update("DELETE FROM users WHERE firebase_uid LIKE 'tm587-seed-%'");
    }

    @Test
    void seedCreatesTwoEventThreadsAndOneAdminChannelWithMessagesAndUnread() throws Exception {
        RequestPostProcessor caller = freshCaller();

        JsonNode result = seed(caller);

        // The endpoint reports exactly the seeded shape: 2 event group threads + 1 admin channel,
        // and the aggregate unread the Chat-tab badge reads (7 unread + 0 read + 3 unread = 10).
        assertThat(result.get("alreadySeeded").asBoolean()).isFalse();
        assertThat(result.get("eventThreads").asInt()).isEqualTo(2);
        assertThat(result.get("adminThreads").asInt()).isEqualTo(1);
        assertThat(result.get("unreadTotal").asLong()).isEqualTo(10L);

        // ...and those threads render through the REAL read API (no mocks): three rows, the derived
        // titles (event headings + the fixed "TeamMarhaba"), and the per-caller unread counts.
        JsonNode list = getJson("/api/v1/me/conversations?size=50", caller);
        JsonNode items = list.get("items");
        assertThat(items).hasSize(3);

        var titles = new ArrayList<String>();
        var byTitle = new java.util.HashMap<String, JsonNode>();
        for (JsonNode row : items) {
            titles.add(row.get("title").asText());
            byTitle.put(row.get("title").asText(), row);
        }
        assertThat(titles)
                .containsExactlyInAnyOrder("Sunday Morning Dog Walk", "Riverside 5k Run Club", "TeamMarhaba");

        assertThat(byTitle.get("Sunday Morning Dog Walk").get("type").asText()).isEqualTo("EVENT_GROUP");
        assertThat(byTitle.get("Sunday Morning Dog Walk").get("unreadCount").asLong()).isEqualTo(7L);
        assertThat(byTitle.get("Sunday Morning Dog Walk").get("lastMessagePreview").asText())
                .isEqualTo("Max says woof — translation: hurry up, humans 🐾");

        assertThat(byTitle.get("Riverside 5k Run Club").get("unreadCount").asLong())
                .as("thread B is marked read → 0 unread, so the list shows a read/unread mix")
                .isEqualTo(0L);

        assertThat(byTitle.get("TeamMarhaba").get("type").asText()).isEqualTo("ADMIN_BROADCAST");
        assertThat(byTitle.get("TeamMarhaba").get("unreadCount").asLong()).isEqualTo(3L);

        // The aggregate unread route the badge reads (TM-582) agrees with the summed rows.
        JsonNode unread = getJson("/api/v1/me/conversations/unread-total", caller);
        assertThat(unread.get("total").asLong()).isEqualTo(10L);
    }

    @Test
    void seedIsIdempotent() throws Exception {
        RequestPostProcessor caller = freshCaller();

        JsonNode first = seed(caller);
        assertThat(first.get("alreadySeeded").asBoolean()).isFalse();
        assertThat(first.get("eventThreads").asInt()).isEqualTo(2);

        // A second seed for the same caller is a no-op: still exactly 3 threads, flagged already-seeded.
        JsonNode second = seed(caller);
        assertThat(second.get("alreadySeeded").asBoolean()).isTrue();
        assertThat(second.get("eventThreads").asInt()).isEqualTo(2);
        assertThat(second.get("adminThreads").asInt()).isEqualTo(1);
        assertThat(second.get("unreadTotal").asLong()).isEqualTo(10L);

        assertThat(getJson("/api/v1/me/conversations?size=50", caller).get("items")).hasSize(3);
    }

    @Test
    void seedRequiresAuthentication() throws Exception {
        // No principal → the default-deny security chain rejects it (401) before any seeding happens.
        mockMvc.perform(post(SEED_URL)).andExpect(status().isUnauthorized());
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────

    private RequestPostProcessor freshCaller() {
        String uid = "chat-seed-" + UUID.randomUUID();
        callerUids.add(uid);
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@teammarhaba.test"), null, List.of()));
    }

    private JsonNode seed(RequestPostProcessor caller) throws Exception {
        String body = mockMvc
                .perform(post(SEED_URL).with(caller))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        return JSON.readTree(body);
    }

    private JsonNode getJson(String url, RequestPostProcessor caller) throws Exception {
        String body = mockMvc
                .perform(get(url).with(caller))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        return JSON.readTree(body);
    }
}
