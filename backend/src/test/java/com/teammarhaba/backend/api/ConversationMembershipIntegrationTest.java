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
import com.teammarhaba.backend.chat.MessageRepository;
import com.teammarhaba.backend.chat.MuteState;
import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.event.AttendanceState;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventAttendance;
import com.teammarhaba.backend.event.EventAttendanceRepository;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.notify.PushDelivery;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushSender;
import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The member-facing self-service over one's own thread membership (TM-471) end-to-end through the
 * real security chain + Postgres, with the {@link PushSender} seam swapped for an in-context recording
 * fake (so no real FCM). Covers the ACs:
 *
 * <ul>
 *   <li><b>mute / unmute</b> — silences THIS thread's push while the member stays active and visible
 *       (still lists, still reads, still posts); unmute restores push;</li>
 *   <li><b>leave / rejoin</b> — leaving hides the thread (reads + posts become {@code 403}) and drops
 *       push, but the event RSVP is unchanged (still GOING); rejoin (while GOING) restores the member;
 *       rejoin after un-RSVPing is a {@code 409};</li>
 *   <li><b>owner-scoped</b> — a non-member / kicked member / unknown thread is a uniform {@code 403};
 *       the organiser can't leave their own thread ({@code 409}); every route is default-deny
 *       ({@code 401} when unauthenticated).</li>
 * </ul>
 *
 * <p>Not {@code @Transactional}: each write commits in its own transaction so the fan-out reads
 * committed rows exactly as production; every account is namespaced by a unique uid so scenarios
 * can't skew each other on the shared container.
 */
@AutoConfigureMockMvc
@Import(ConversationMembershipIntegrationTest.RecordingSenderConfig.class)
class ConversationMembershipIntegrationTest extends AbstractIntegrationTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Autowired private MockMvc mockMvc;
    @Autowired private UserRepository users;
    @Autowired private ConversationRepository conversations;
    @Autowired private ConversationMemberRepository members;
    @Autowired private MessageRepository messages;
    @Autowired private DeviceTokenRepository deviceTokens;
    @Autowired private EventRepository events;
    @Autowired private EventAttendanceRepository attendance;
    @Autowired private RecordingPushSender sender;

    @BeforeEach
    void cleanSlate() {
        messages.deleteAll();
        members.deleteAll();
        conversations.deleteAll();
        deviceTokens.deleteAll();
        sender.reset();
    }

    // ── mute / unmute ────────────────────────────────────────────────────────────────────────────

    @Test
    void muteFlagsMembershipSuppressesPushButKeepsMemberActiveVisibleAndPostable() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("mute")));
        activeMember(thread, "mute-poster", "tok-mute-poster");
        activeMember(thread, "mute-b", "tok-mute-b");

        // B mutes → 200, flagged muted (still a member: not left).
        JsonNode muted = postJson("/api/v1/conversations/" + thread.getId() + "/mute", user("mute-b"));
        assertThat(muted.get("conversationId").asLong()).isEqualTo(thread.getId());
        assertThat(muted.get("notificationsMuted").asBoolean()).isTrue();
        assertThat(muted.get("left").asBoolean()).isFalse();

        // The thread still shows in B's list, flagged notificationsMuted (they still see it).
        JsonNode row = onlyListRow("mute-b");
        assertThat(row.get("id").asLong()).isEqualTo(thread.getId());
        assertThat(row.get("notificationsMuted").asBoolean()).isTrue();
        assertThat(row.get("left").asBoolean()).isFalse();

        // B can still READ the thread...
        mockMvc.perform(get("/api/v1/conversations/" + thread.getId() + "/messages").with(user("mute-b")))
                .andExpect(status().isOk());
        // ...and still POST to it (self-mute only silences inbound push; it never gags the member).
        mockMvc.perform(post("/api/v1/conversations/{id}/messages", thread.getId())
                        .with(user("mute-b"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"still here, just muted\"}"))
                .andExpect(status().isCreated());

        // The poster posts — the muted member gets NO push (they're the only other member).
        sender.reset();
        mockMvc.perform(post("/api/v1/conversations/{id}/messages", thread.getId())
                        .with(user("mute-poster"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"anyone about?\"}"))
                .andExpect(status().isCreated());
        assertThat(deliveredTokens()).doesNotContain("tok-mute-b");
        assertThat(sender.deliveries()).isEmpty();

        // B un-mutes → 200, flag cleared; now the poster's next message reaches them.
        JsonNode unmuted = postJson("/api/v1/conversations/" + thread.getId() + "/unmute", user("mute-b"));
        assertThat(unmuted.get("notificationsMuted").asBoolean()).isFalse();

        sender.reset();
        mockMvc.perform(post("/api/v1/conversations/{id}/messages", thread.getId())
                        .with(user("mute-poster"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"you back?\"}"))
                .andExpect(status().isCreated());
        assertThat(deliveredTokens()).containsExactly("tok-mute-b");
    }

    // ── leave / rejoin ───────────────────────────────────────────────────────────────────────────

    @Test
    void leaveHidesThreadBlocksReadAndPostSuppressesPushButKeepsRsvp() throws Exception {
        long eventId = openEvent("leave");
        Conversation thread = conversations.save(Conversation.forEvent(eventId));
        activeMember(thread, "leave-poster", "tok-leave-poster");
        long bId = activeMember(thread, "leave-b", "tok-leave-b");
        attendance.save(new EventAttendance(eventId, bId, AttendanceState.GOING)); // B is GOING

        // B leaves → 200, flagged left (RSVP untouched).
        JsonNode left = postJson("/api/v1/conversations/" + thread.getId() + "/leave", user("leave-b"));
        assertThat(left.get("left").asBoolean()).isTrue();
        assertThat(left.get("notificationsMuted").asBoolean()).isFalse();
        assertThat(members.findByConversationIdAndUserId(thread.getId(), bId).orElseThrow().getMute())
                .isEqualTo(MuteState.LEFT);

        // The event RSVP is UNCHANGED — still GOING (the AC's core promise).
        assertThat(attendance.findByEventIdAndUserId(eventId, bId).orElseThrow().getState())
                .as("self-leaving the chat leaves the event RSVP GOING")
                .isEqualTo(AttendanceState.GOING);

        // The thread is now hidden from reads + posts for B (must rejoin first).
        mockMvc.perform(get("/api/v1/conversations/" + thread.getId() + "/messages").with(user("leave-b")))
                .andExpect(status().isForbidden());
        mockMvc.perform(post("/api/v1/conversations/{id}/messages", thread.getId())
                        .with(user("leave-b"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"i left but…\"}"))
                .andExpect(status().isForbidden());

        // In the list it renders as a de-emphasised "you left — rejoin" row (flagged left), not hidden
        // outright — that's where the rejoin affordance lives.
        JsonNode row = onlyListRow("leave-b");
        assertThat(row.get("id").asLong()).isEqualTo(thread.getId());
        assertThat(row.get("left").asBoolean()).isTrue();

        // A new message from the poster does NOT push to the left member.
        sender.reset();
        mockMvc.perform(post("/api/v1/conversations/{id}/messages", thread.getId())
                        .with(user("leave-poster"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"still on for tonight?\"}"))
                .andExpect(status().isCreated());
        assertThat(deliveredTokens()).doesNotContain("tok-leave-b");
    }

    @Test
    void rejoinWhileStillGoingRestoresActiveMembership() throws Exception {
        long eventId = openEvent("rejoin-ok");
        Conversation thread = conversations.save(Conversation.forEvent(eventId));
        long bId = leftMember(thread, "rejoin-b"); // already self-left
        attendance.save(new EventAttendance(eventId, bId, AttendanceState.GOING)); // still GOING

        JsonNode rejoined = postJson("/api/v1/conversations/" + thread.getId() + "/rejoin", user("rejoin-b"));
        assertThat(rejoined.get("left").asBoolean()).isFalse();
        assertThat(members.findByConversationIdAndUserId(thread.getId(), bId).orElseThrow().getMute())
                .isEqualTo(MuteState.NONE);

        // Back in: reads + posts work again.
        mockMvc.perform(get("/api/v1/conversations/" + thread.getId() + "/messages").with(user("rejoin-b")))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/conversations/{id}/messages", thread.getId())
                        .with(user("rejoin-b"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"back in\"}"))
                .andExpect(status().isCreated());
    }

    @Test
    void rejoinAfterUnRsvpingTheEventIsAConflict() throws Exception {
        long eventId = openEvent("rejoin-gone");
        Conversation thread = conversations.save(Conversation.forEvent(eventId));
        leftMember(thread, "rejoin-gone-b"); // self-left AND no attendance row (un-RSVPed)

        mockMvc.perform(post("/api/v1/conversations/{id}/rejoin", thread.getId()).with(user("rejoin-gone-b")))
                .andExpect(status().isConflict());

        // Still left (the failed rejoin didn't half-apply) — reads stay forbidden.
        mockMvc.perform(get("/api/v1/conversations/" + thread.getId() + "/messages").with(user("rejoin-gone-b")))
                .andExpect(status().isForbidden());
    }

    @Test
    void leaveAndRejoinAreIdempotent() throws Exception {
        long eventId = openEvent("idem");
        Conversation thread = conversations.save(Conversation.forEvent(eventId));
        long bId = activeMember(thread, "idem-b", "tok-idem-b");
        attendance.save(new EventAttendance(eventId, bId, AttendanceState.GOING));

        // Leaving twice is a no-op success; rejoining twice is too.
        postJson("/api/v1/conversations/" + thread.getId() + "/leave", user("idem-b"));
        JsonNode leftAgain = postJson("/api/v1/conversations/" + thread.getId() + "/leave", user("idem-b"));
        assertThat(leftAgain.get("left").asBoolean()).isTrue();

        postJson("/api/v1/conversations/" + thread.getId() + "/rejoin", user("idem-b"));
        JsonNode rejoinedAgain = postJson("/api/v1/conversations/" + thread.getId() + "/rejoin", user("idem-b"));
        assertThat(rejoinedAgain.get("left").asBoolean()).isFalse();
    }

    // ── owner-scoping / guards ─────────────────────────────────────────────────────────────────────

    @Test
    void organiserCannotLeaveTheirOwnThread() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("host-leave")));
        // The organiser is an ADMIN member of their thread.
        long hostId = provision("host-leave-admin");
        ConversationMember admin = new ConversationMember(thread.getId(), hostId, MemberRole.ADMIN);
        members.save(admin);

        mockMvc.perform(post("/api/v1/conversations/{id}/leave", thread.getId()).with(user("host-leave-admin")))
                .andExpect(status().isConflict());

        // Still an active ADMIN member (the failed leave didn't apply).
        assertThat(members.findByConversationIdAndUserId(thread.getId(), hostId).orElseThrow().getMute())
                .isEqualTo(MuteState.NONE);
    }

    @Test
    void selfServiceIsOwnerScopedAndUnknownThreadIsForbidden() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("scope")));
        activeMember(thread, "scope-member", "tok-scope-member");
        provision("scope-outsider"); // a real account, not a member of this thread

        // A non-member can't mute or leave someone else's thread — a uniform 403 (owner-scoped).
        mockMvc.perform(post("/api/v1/conversations/{id}/mute", thread.getId()).with(user("scope-outsider")))
                .andExpect(status().isForbidden());
        mockMvc.perform(post("/api/v1/conversations/{id}/leave", thread.getId()).with(user("scope-outsider")))
                .andExpect(status().isForbidden());

        // A kicked (REMOVED) member is treated identically to a non-member.
        long kickedId = provision("scope-kicked");
        ConversationMember kicked = new ConversationMember(thread.getId(), kickedId, MemberRole.MEMBER);
        kicked.setMute(MuteState.REMOVED);
        members.save(kicked);
        mockMvc.perform(post("/api/v1/conversations/{id}/mute", thread.getId()).with(user("scope-kicked")))
                .andExpect(status().isForbidden());

        // An unknown thread id is the same 403, never a 404 — ids can't be probed.
        mockMvc.perform(post("/api/v1/conversations/{id}/mute", 9_999_999L).with(user("scope-member")))
                .andExpect(status().isForbidden());
    }

    @Test
    void everySelfServiceRouteRequiresAuthentication() throws Exception {
        for (String action : List.of("mute", "unmute", "leave", "rejoin")) {
            mockMvc.perform(post("/api/v1/conversations/1/" + action)).andExpect(status().isUnauthorized());
        }
    }

    // ── fixtures ─────────────────────────────────────────────────────────────────────────────────

    private static RequestPostProcessor user(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of(new SimpleGrantedAuthority("ROLE_USER"))));
    }

    private long provision(String uid) {
        User user = users.findByFirebaseUid(uid)
                .orElseGet(() -> users.saveAndFlush(new User(uid, uid + "@example.com", uid)));
        user.setNotificationPref(NotificationPref.BOTH);
        return users.saveAndFlush(user).getId();
    }

    /** An open-ended, never-closing event created by a fresh host; returns its id. */
    private long openEvent(String heading) {
        Instant now = Instant.now();
        return events.save(new Event(
                        heading,
                        "A friendly meetup.",
                        "Marhaba Cafe, 12 High St",
                        "Europe/London",
                        now.plus(Duration.ofDays(7)),
                        now.minus(Duration.ofHours(1)),
                        now.plus(Duration.ofDays(30)),
                        provision(heading + "-host"),
                        now))
                .getId();
    }

    /** Add an active ({@code NONE}) member with a push-eligible device token; returns the user id. */
    private long activeMember(Conversation thread, String uid, String token) {
        long userId = provision(uid);
        members.save(new ConversationMember(thread.getId(), userId, MemberRole.MEMBER));
        deviceTokens.saveAndFlush(new DeviceToken(userId, token, DevicePlatform.ANDROID, Instant.now()));
        return userId;
    }

    /** Add a member who has already self-left the thread ({@link MuteState#LEFT}); returns the user id. */
    private long leftMember(Conversation thread, String uid) {
        long userId = provision(uid);
        ConversationMember m = new ConversationMember(thread.getId(), userId, MemberRole.MEMBER);
        m.leave();
        members.save(m);
        return userId;
    }

    /** The single conversation row in the caller's list (fails if there isn't exactly one). */
    private JsonNode onlyListRow(String uid) throws Exception {
        JsonNode body = JSON.readTree(mockMvc.perform(get("/api/v1/me/conversations").with(user(uid)))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString());
        JsonNode items = body.get("items");
        assertThat(items).hasSize(1);
        return items.get(0);
    }

    private JsonNode postJson(String url, RequestPostProcessor caller) throws Exception {
        String body = mockMvc.perform(post(url).with(caller))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        return JSON.readTree(body);
    }

    private List<String> deliveredTokens() {
        return sender.deliveries().stream().map(Delivery::token).toList();
    }

    // ── harness ──────────────────────────────────────────────────────────────────────────────────

    @TestConfiguration
    static class RecordingSenderConfig {
        @Bean
        @Primary
        RecordingPushSender recordingPushSender() {
            return new RecordingPushSender();
        }
    }

    record Delivery(String token, PushMessage message) {}

    static final class RecordingPushSender implements PushSender {
        private final List<Delivery> deliveries = new ArrayList<>();

        @Override
        public synchronized PushDelivery send(String token, PushMessage message) {
            deliveries.add(new Delivery(token, message));
            return PushDelivery.DELIVERED;
        }

        synchronized List<Delivery> deliveries() {
            return List.copyOf(deliveries);
        }

        synchronized void reset() {
            deliveries.clear();
        }
    }
}
