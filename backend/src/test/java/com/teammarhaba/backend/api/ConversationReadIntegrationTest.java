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
import com.teammarhaba.backend.chat.Conversation;
import com.teammarhaba.backend.chat.ConversationMember;
import com.teammarhaba.backend.chat.ConversationMemberRepository;
import com.teammarhaba.backend.chat.ConversationRepository;
import com.teammarhaba.backend.chat.MemberRole;
import com.teammarhaba.backend.chat.Message;
import com.teammarhaba.backend.chat.MessageRepository;
import com.teammarhaba.backend.chat.MuteState;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The conversation read API contract over real HTTP + Postgres (TM-436) — the read half of the
 * TM-435 conversation model the app's single "chat" section renders. Exercises the three routes end
 * to end against the shared thread store:
 *
 * <ul>
 *   <li>{@code GET /me/conversations} — the caller's threads, most-recently-active first, each with
 *       type, a derived title (event heading / "TeamMarhaba"), last-message preview, per-caller
 *       unread count and event ref; paged, caller-scoped, and excluding kicked (REMOVED) memberships.
 *   <li>{@code GET /conversations/{id}/messages} — a thread's live messages, chronological and paged,
 *       members-only ({@code 403} otherwise), excluding moderation-removed messages.
 *   <li>{@code POST /conversations/{id}/read} — advances the caller's read cursor (unread → 0),
 *       members-only.
 * </ul>
 *
 * <p>Rows are inserted <b>straight through the repositories</b> (the writer paths — event-chat send
 * TM-433 / admin-broadcast TM-432 — build in parallel and aren't depended on here), so this suite
 * validates the read/mark-read API in isolation. Deliberately <b>not</b> {@code @Transactional}: each
 * {@code save} runs in its own transaction so every row gets its own DB-side {@code now()} — a shared
 * test transaction would stamp one identical instant on every row and defeat the ordering /
 * unread-cursor assertions. Every scenario uses freshly-provisioned users (unique uids) so the shared
 * integration context's accumulated rows never skew a caller-scoped list or count.
 */
@AutoConfigureMockMvc
class ConversationReadIntegrationTest extends AbstractIntegrationTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ConversationRepository conversations;

    @Autowired
    private ConversationMemberRepository members;

    @Autowired
    private MessageRepository messages;

    @Autowired
    private EventRepository events;

    @Autowired
    private UserRepository users;

    // ------------------------------------------------------------------ list: order, fields, scope

    @Test
    void listReturnsCallerThreadsMostRecentlyActiveFirstWithTitlesPreviewsUnreadAndEventRef()
            throws Exception {
        String uid = "conv-list-" + UUID.randomUUID();
        Long userId = newUser(uid);

        // An event group chat and an admin broadcast the caller belongs to...
        Long eventId = newEvent("Padel night");
        Long eventThread = newEventThread(eventId);
        addMember(eventThread, userId, MemberRole.MEMBER, MuteState.NONE);
        Long broadcast = newBroadcastThread();
        addMember(broadcast, userId, MemberRole.MEMBER, MuteState.NONE);

        // ...plus a thread the caller is NOT a member of — must never leak into their list.
        Long foreign = newBroadcastThread();
        addMember(foreign, newUser("conv-list-other-" + UUID.randomUUID()), MemberRole.MEMBER, MuteState.NONE);
        messages.save(Message.fromSystem(foreign, "not yours", null));

        // Activity order: post to the event thread first, then the broadcast (separate txns → the
        // broadcast's message is newer), so the broadcast sorts ahead as most-recently-active.
        messages.save(Message.fromUser(eventThread, newUser("conv-list-sender"), "see you there"));
        messages.save(Message.fromSystem(broadcast, "Welcome to TeamMarhaba", "/home"));

        JsonNode body = getJson("/api/v1/me/conversations", caller(uid));

        // Only the caller's two threads, most-recently-active first (broadcast, then event chat).
        assertThat(ids(body)).containsExactly(broadcast, eventThread);
        assertThat(body.get("totalElements").asLong()).isEqualTo(2);

        JsonNode top = body.get("items").get(0);
        assertThat(top.get("type").asText()).isEqualTo("ADMIN_BROADCAST");
        assertThat(top.get("title").asText()).isEqualTo("TeamMarhaba"); // fixed broadcast title
        assertThat(top.get("eventId").isNull()).isTrue(); // no event ref for a broadcast
        assertThat(top.get("lastMessagePreview").asText()).isEqualTo("Welcome to TeamMarhaba");
        assertThat(top.get("unreadCount").asLong()).isEqualTo(1); // caller has never read it

        JsonNode second = body.get("items").get(1);
        assertThat(second.get("type").asText()).isEqualTo("EVENT_GROUP");
        assertThat(second.get("title").asText()).isEqualTo("Padel night"); // derived from event heading
        assertThat(second.get("eventId").asLong()).isEqualTo(eventId); // event ref
        assertThat(second.get("lastMessagePreview").asText()).isEqualTo("see you there");
        assertThat(second.get("unreadCount").asLong()).isEqualTo(1);
    }

    @Test
    void listIsPagedWithAccurateTotals() throws Exception {
        String uid = "conv-page-" + UUID.randomUUID();
        Long userId = newUser(uid);

        // Three threads, each with one message, posted oldest→newest so the list order is c3, c2, c1.
        Long c1 = threadWithMessage(userId, "one");
        Long c2 = threadWithMessage(userId, "two");
        Long c3 = threadWithMessage(userId, "three");

        JsonNode page0 = getJson("/api/v1/me/conversations?size=2", caller(uid));
        assertThat(ids(page0)).containsExactly(c3, c2);
        assertThat(page0.get("page").asInt()).isEqualTo(0);
        assertThat(page0.get("size").asInt()).isEqualTo(2);
        assertThat(page0.get("totalElements").asLong()).isEqualTo(3);
        assertThat(page0.get("totalPages").asInt()).isEqualTo(2);

        JsonNode page1 = getJson("/api/v1/me/conversations?size=2&page=1", caller(uid));
        assertThat(ids(page1)).containsExactly(c1);
    }

    @Test
    void listWithAHugePageNumberReturnsAnEmptyPageNotA500() throws Exception {
        // A brand-new user with zero conversations, asked for a wildly out-of-range page. page * size
        // overflows a 32-bit int to a negative window start, which used to drive subList out of range
        // and 500 the request (TM-575). The clamped long math now returns an empty page (still 200) —
        // getJson asserts the 200, so a regression to 500 fails here.
        String uid = "conv-hugepage-" + UUID.randomUUID();
        newUser(uid);

        JsonNode body = getJson("/api/v1/me/conversations?page=999999999", caller(uid));
        assertThat(body.get("items")).isEmpty();
        assertThat(body.get("page").asInt()).isEqualTo(999999999);
        assertThat(body.get("totalElements").asLong()).isZero();
    }

    @Test
    void listExcludesKickedMembershipsAndSilentThreadReadsAsZeroUnread() throws Exception {
        String uid = "conv-removed-" + UUID.randomUUID();
        Long userId = newUser(uid);

        Long active = newBroadcastThread();
        addMember(active, userId, MemberRole.MEMBER, MuteState.NONE); // silent — no messages yet

        Long kicked = newBroadcastThread();
        addMember(kicked, userId, MemberRole.MEMBER, MuteState.REMOVED);
        messages.save(Message.fromSystem(kicked, "you can't see this", null));

        JsonNode body = getJson("/api/v1/me/conversations", caller(uid));

        // The REMOVED thread is hidden; only the active membership shows.
        assertThat(ids(body)).containsExactly(active);
        JsonNode only = body.get("items").get(0);
        // A silent thread has no preview and nothing unread, and still sorts by its creation instant.
        assertThat(only.get("lastMessagePreview").isNull()).isTrue();
        assertThat(only.get("lastMessageAt").isNull()).isTrue();
        assertThat(only.get("unreadCount").asLong()).isZero();
        assertThat(only.get("lastActiveAt").isNull()).isFalse();
    }

    // ------------------------------------------------------------------ thread: order, paging, moderation

    @Test
    void threadMessagesAreChronologicalPagedAndExcludeSoftDeleted() throws Exception {
        String uid = "conv-thread-" + UUID.randomUUID();
        Long userId = newUser(uid);
        Long thread = newBroadcastThread();
        addMember(thread, userId, MemberRole.MEMBER, MuteState.NONE);

        Long m1 = messages.save(Message.fromUser(thread, newUser("conv-thread-a"), "first")).getId();
        Long m2 = messages.save(Message.fromSystem(thread, "system from TeamMarhaba", "/home")).getId();
        Long m3 = messages.save(Message.fromUser(thread, newUser("conv-thread-c"), "third")).getId();

        // Chronological (oldest→newest), paged: page 0 size 2 = [m1, m2].
        JsonNode page0 = getJson("/api/v1/conversations/" + thread + "/messages?size=2", caller(uid));
        assertThat(ids(page0)).containsExactly(m1, m2);
        assertThat(page0.get("totalElements").asLong()).isEqualTo(3);

        // The system message carries a null sender + the system flag.
        JsonNode systemMsg = page0.get("items").get(1);
        assertThat(systemMsg.get("system").asBoolean()).isTrue();
        assertThat(systemMsg.get("senderId").isNull()).isTrue();
        assertThat(systemMsg.get("body").asText()).isEqualTo("system from TeamMarhaba");
        assertThat(systemMsg.get("deepLink").asText()).isEqualTo("/home");

        // Each message carries its reaction summary (TM-461) inline — empty here (nothing reacted yet),
        // but the field is always present so the timeline can render chips without a second call.
        assertThat(systemMsg.get("reactions").isArray()).isTrue();
        assertThat(systemMsg.get("reactions")).isEmpty();

        JsonNode page1 = getJson("/api/v1/conversations/" + thread + "/messages?size=2&page=1", caller(uid));
        assertThat(ids(page1)).containsExactly(m3);

        // Soft-delete m2 (moderation) — it drops out of the timeline entirely.
        Message removed = messages.findById(m2).orElseThrow();
        removed.softDelete(Instant.now());
        messages.save(removed);

        JsonNode afterDelete = getJson("/api/v1/conversations/" + thread + "/messages", caller(uid));
        assertThat(ids(afterDelete)).containsExactly(m1, m3);
        assertThat(afterDelete.get("totalElements").asLong()).isEqualTo(2);
    }

    @Test
    void threadIsMembersOnly() throws Exception {
        String memberUid = "conv-403-member-" + UUID.randomUUID();
        Long memberId = newUser(memberUid);
        Long thread = newBroadcastThread();
        addMember(thread, memberId, MemberRole.MEMBER, MuteState.NONE);
        messages.save(Message.fromSystem(thread, "members only", null));

        // A signed-in non-member is forbidden (not 404 — thread existence isn't leaked).
        String outsiderUid = "conv-403-outsider-" + UUID.randomUUID();
        newUser(outsiderUid);
        mockMvc.perform(get("/api/v1/conversations/" + thread + "/messages").with(caller(outsiderUid)))
                .andExpect(status().isForbidden());

        // A kicked (REMOVED) member is equally forbidden.
        String kickedUid = "conv-403-kicked-" + UUID.randomUUID();
        Long kickedId = newUser(kickedUid);
        addMember(thread, kickedId, MemberRole.MEMBER, MuteState.REMOVED);
        mockMvc.perform(get("/api/v1/conversations/" + thread + "/messages").with(caller(kickedUid)))
                .andExpect(status().isForbidden());

        // An unknown thread id is the same 403, never a 404.
        mockMvc.perform(get("/api/v1/conversations/99999999/messages").with(caller(memberUid)))
                .andExpect(status().isForbidden());

        // The genuine member reads it fine.
        mockMvc.perform(get("/api/v1/conversations/" + thread + "/messages").with(caller(memberUid)))
                .andExpect(status().isOk());
    }

    // ------------------------------------------------------------------ unread + mark-read

    @Test
    void unreadIsRelativeToCursorAndMarkReadClearsIt() throws Exception {
        String uid = "conv-unread-" + UUID.randomUUID();
        Long userId = newUser(uid);
        Long thread = newBroadcastThread();
        addMember(thread, userId, MemberRole.MEMBER, MuteState.NONE);

        messages.save(Message.fromSystem(thread, "m1", null));
        messages.save(Message.fromSystem(thread, "m2", null));
        messages.save(Message.fromSystem(thread, "m3", null));

        // Never-read member: everything is unread.
        assertThat(unreadFor(uid, thread)).isEqualTo(3);

        // Move the cursor to the OLDEST message's DB instant (sourced from the DB, not the server
        // clock, so this is skew-free): only the two strictly-newer messages remain unread.
        List<Message> chronological = chronological(thread);
        Instant oldestAt = chronological.get(0).getCreatedAt();
        ConversationMember member = members.findByConversationIdAndUserId(thread, userId).orElseThrow();
        member.markRead(oldestAt);
        members.save(member);
        assertThat(unreadFor(uid, thread)).isEqualTo(2);

        // Mark-read via the API advances the cursor past everything → unread 0, and reports it back.
        JsonNode marked = postJson("/api/v1/conversations/" + thread + "/read", caller(uid));
        assertThat(marked.get("conversationId").asLong()).isEqualTo(thread);
        assertThat(marked.get("lastReadAt").isNull()).isFalse();
        assertThat(marked.get("unreadCount").asLong()).isZero();

        // The advance was persisted (a follow-up list agrees) and mark-read is idempotent.
        assertThat(unreadFor(uid, thread)).isZero();
        JsonNode again = postJson("/api/v1/conversations/" + thread + "/read", caller(uid));
        assertThat(again.get("unreadCount").asLong()).isZero();
    }

    @Test
    void markReadStampsCursorFromNewestMessageDbInstantSoUnreadIsZeroRegardlessOfClockSkew()
            throws Exception {
        // TM-580: markRead used to stamp the cursor from Instant.now() (the app clock), but
        // message.created_at is DB-authoritative (DEFAULT now()) and countUnread compares
        // created_at > last_read_at — so under app/DB clock skew a just-seen message could stay
        // counted unread and MarkReadResponse.unreadCount could be non-zero right after mark-read.
        // The cursor is now stamped from the newest live message's DB created_at, sharing one clock
        // with the timestamps it is compared against.
        String uid = "conv-mr-skew-" + UUID.randomUUID();
        Long userId = newUser(uid);
        Long thread = newBroadcastThread();
        addMember(thread, userId, MemberRole.MEMBER, MuteState.NONE);

        // Two messages in separate txns (each gets its own DB now()), so there is a definite newest.
        messages.save(Message.fromSystem(thread, "m1", null));
        messages.save(Message.fromSystem(thread, "m2", null));

        // The newest live message's DB-authoritative created_at — sourced from the DB (re-fetched
        // through the finder), never the app clock. This is the exact value the cursor must land on.
        List<Message> chronological = chronological(thread);
        Instant newestAt = chronological.get(chronological.size() - 1).getCreatedAt();

        // Mark read via the API with no new message landing: unread must be 0.
        JsonNode marked = postJson("/api/v1/conversations/" + thread + "/read", caller(uid));
        assertThat(marked.get("unreadCount").asLong()).isZero();

        // Proof the cursor is DB-sourced, not app-sourced: it equals the newest message's DB
        // created_at exactly. An Instant.now() (app-clock) stamp would essentially never match a DB
        // timestamp to the microsecond — and under skew could sit behind created_at, the very bug.
        Instant cursor = Instant.parse(marked.get("lastReadAt").asText());
        assertThat(cursor).isEqualTo(newestAt);

        // And it stays 0 on a re-read (idempotent, forward-only cursor).
        assertThat(unreadFor(uid, thread)).isZero();
    }

    @Test
    void markReadIsMembersOnly() throws Exception {
        Long thread = newBroadcastThread();
        addMember(thread, newUser("conv-mr-member-" + UUID.randomUUID()), MemberRole.MEMBER, MuteState.NONE);

        String outsiderUid = "conv-mr-outsider-" + UUID.randomUUID();
        newUser(outsiderUid);
        mockMvc.perform(post("/api/v1/conversations/" + thread + "/read").with(caller(outsiderUid)))
                .andExpect(status().isForbidden());
    }

    // ------------------------------------------------------------------ default-deny

    @Test
    void everyRouteRequiresAuthentication() throws Exception {
        mockMvc.perform(get("/api/v1/me/conversations")).andExpect(status().isUnauthorized());
        mockMvc.perform(get("/api/v1/conversations/1/messages")).andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/conversations/1/read")).andExpect(status().isUnauthorized());
    }

    // ------------------------------------------------------------------ fixtures

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    private Long newUser(String uid) {
        return users.save(new User(uid, uid + "@example.com", uid)).getId();
    }

    private Long newEvent(String heading) {
        Instant now = Instant.now();
        return events.save(new Event(
                        heading,
                        "A friendly meetup.",
                        "Marhaba Cafe, 12 High St",
                        "Europe/London",
                        now.plus(Duration.ofDays(7)),
                        now.minus(Duration.ofHours(1)),
                        now.plus(Duration.ofDays(30)),
                        newUser(heading + "-creator-" + UUID.randomUUID()),
                        now))
                .getId();
    }

    private Long newEventThread(Long eventId) {
        return conversations.save(Conversation.forEvent(eventId)).getId();
    }

    private Long newBroadcastThread() {
        return conversations.save(Conversation.adminBroadcast()).getId();
    }

    private void addMember(Long conversationId, Long userId, MemberRole role, MuteState mute) {
        ConversationMember member = new ConversationMember(conversationId, userId, role);
        member.setMute(mute);
        members.save(member);
    }

    /** A fresh broadcast thread the user is a member of, carrying one message (so it isn't silent). */
    private Long threadWithMessage(Long userId, String body) {
        Long thread = newBroadcastThread();
        addMember(thread, userId, MemberRole.MEMBER, MuteState.NONE);
        messages.save(Message.fromSystem(thread, body, null));
        return thread;
    }

    private List<Message> chronological(Long conversationId) {
        List<Message> live =
                messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(conversationId);
        List<Message> ordered = new ArrayList<>(live);
        java.util.Collections.reverse(ordered); // newest-first finder → oldest-first
        return ordered;
    }

    /** The caller's unread count for one thread, read back through the list endpoint. */
    private long unreadFor(String uid, Long conversationId) throws Exception {
        JsonNode body = getJson("/api/v1/me/conversations", caller(uid));
        for (JsonNode item : body.get("items")) {
            if (item.get("id").asLong() == conversationId) {
                return item.get("unreadCount").asLong();
            }
        }
        throw new AssertionError("conversation " + conversationId + " not in caller's list");
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
        List<Long> out = new ArrayList<>();
        for (JsonNode item : page.get("items")) {
            out.add(item.get("id").asLong());
        }
        return out;
    }
}
