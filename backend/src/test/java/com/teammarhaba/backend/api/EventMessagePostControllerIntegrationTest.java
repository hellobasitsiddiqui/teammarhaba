package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditEvent;
import com.teammarhaba.backend.audit.AuditRepository;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.chat.Conversation;
import com.teammarhaba.backend.chat.ConversationMember;
import com.teammarhaba.backend.chat.ConversationMemberRepository;
import com.teammarhaba.backend.chat.ConversationRepository;
import com.teammarhaba.backend.chat.MemberRole;
import com.teammarhaba.backend.chat.Message;
import com.teammarhaba.backend.chat.MessageRepository;
import com.teammarhaba.backend.chat.MuteState;
import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.event.Event;
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
 * The event-chat post endpoint {@code POST /api/v1/conversations/{id}/messages} (TM-447) end-to-end
 * through the real security chain + Postgres, with the {@link PushSender} seam swapped for an
 * in-context recording fake (so no real FCM). Covers every AC bullet:
 *
 * <ul>
 *   <li><b>member posts OK + fan-out fires</b> — an active member posts, gets {@code 201} + the
 *       created-message DTO, the row is persisted, and the push reaches the thread's other active
 *       members (not the sender); one {@code EVENT_CHAT_MESSAGE_POSTED} audit row is written;</li>
 *   <li><b>membership gate</b> — a non-member is {@code 403} and nothing is persisted / pushed;</li>
 *   <li><b>muted / removed block</b> — a {@code READ_ONLY} (muted) and a {@code REMOVED} (kicked)
 *       member are both {@code 403} (posting is stricter than reacting);</li>
 *   <li><b>closed-thread block</b> — a manually soft-closed thread <em>and</em> a thread past its
 *       close-policy window (TM-446) are both {@code 409};</li>
 *   <li><b>length cap</b> — a blank body and an over-500-char body are both a Bean-Validation
 *       {@code 400}; a 500-char body is accepted;</li>
 *   <li><b>unknown thread</b> — a uniform {@code 403} (never a {@code 404}, TM-573) so a POST can't
 *       probe which thread ids exist, indistinguishable from a non-member.</li>
 * </ul>
 */
@AutoConfigureMockMvc
@Import(EventMessagePostControllerIntegrationTest.RecordingSenderConfig.class)
class EventMessagePostControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired private MockMvc mockMvc;
    @Autowired private UserRepository users;
    @Autowired private ConversationRepository conversations;
    @Autowired private ConversationMemberRepository members;
    @Autowired private MessageRepository messages;
    @Autowired private DeviceTokenRepository deviceTokens;
    @Autowired private EventRepository events;
    @Autowired private AuditRepository audits;
    @Autowired private RecordingPushSender sender;

    @BeforeEach
    void cleanSlate() {
        // Child → parent so FK cascades don't matter; per-test users/events are unique so are harmless.
        messages.deleteAll();
        members.deleteAll();
        conversations.deleteAll();
        deviceTokens.deleteAll();
        sender.reset();
    }

    // ── happy path ───────────────────────────────────────────────────────────────────────────────

    @Test
    void activeMemberPostsMessageThenPushFansOutToOtherMembers() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("post-ok")));
        long senderId = activeMember(thread, "p-sender", "tok-sender"); // the poster
        activeMember(thread, "p-other", "tok-other"); // the recipient of the fan-out

        mockMvc.perform(post("/api/v1/conversations/{id}/messages", thread.getId())
                        .with(user("p-sender"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"hi team, who's coming?\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").isNumber())
                .andExpect(jsonPath("$.senderId").isNumber()) // value checked against the DB row below
                .andExpect(jsonPath("$.body").value("hi team, who's coming?"))
                .andExpect(jsonPath("$.createdAt").isNotEmpty())
                .andExpect(jsonPath("$.reactions").isEmpty());

        // Persisted exactly once in the thread.
        List<Message> stored = messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(
                thread.getId());
        assertThat(stored).hasSize(1);
        assertThat(stored.get(0).getBody()).isEqualTo("hi team, who's coming?");
        assertThat(stored.get(0).getSenderId()).isEqualTo(senderId);

        // Fan-out reached the OTHER active member, never the sender (TM-437 hook).
        assertThat(deliveredTokens()).containsExactly("tok-other");

        // One audit row for the post, targeting the conversation, carrying the message id.
        List<AuditEvent> audit = audits.findByTargetTypeAndTargetIdOrderByCreatedAtDesc(
                "Conversation", thread.getId().toString());
        assertThat(audit).hasSize(1);
        assertThat(audit.get(0).getAction()).isEqualTo(AuditAction.EVENT_CHAT_MESSAGE_POSTED);
    }

    @Test
    void bodyAtTheLengthCapIsAccepted() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("post-cap")));
        activeMember(thread, "c-sender", "tok-c-sender");

        String maxBody = "a".repeat(500);
        mockMvc.perform(post("/api/v1/conversations/{id}/messages", thread.getId())
                        .with(user("c-sender"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"" + maxBody + "\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.body").value(maxBody));
    }

    // ── membership gate ──────────────────────────────────────────────────────────────────────────

    @Test
    void nonMemberIsForbiddenAndNothingIsPersisted() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("post-nonmember")));
        activeMember(thread, "nm-member", "tok-nm-member"); // a member exists, but the caller is not one
        provision("nm-outsider"); // a real account, just not a member of this thread

        mockMvc.perform(post("/api/v1/conversations/{id}/messages", thread.getId())
                        .with(user("nm-outsider"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"let me in\"}"))
                .andExpect(status().isForbidden());

        assertThat(messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId()))
                .isEmpty();
        assertThat(sender.deliveries()).isEmpty();
    }

    @Test
    void readOnlyMutedMemberIsForbidden() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("post-readonly")));
        member(thread, "ro-member", "tok-ro", MuteState.READ_ONLY); // may read, not post

        mockMvc.perform(post("/api/v1/conversations/{id}/messages", thread.getId())
                        .with(user("ro-member"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"muted but trying\"}"))
                .andExpect(status().isForbidden());

        assertThat(messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId()))
                .isEmpty();
    }

    @Test
    void removedMemberIsForbidden() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("post-removed")));
        member(thread, "rm-member", "tok-rm", MuteState.REMOVED); // kicked from the thread

        mockMvc.perform(post("/api/v1/conversations/{id}/messages", thread.getId())
                        .with(user("rm-member"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"kicked but trying\"}"))
                .andExpect(status().isForbidden());
    }

    // ── closed-thread block (consumes TM-446's isThreadReadOnly) ──────────────────────────────────

    @Test
    void manuallyClosedThreadRejectsThePostAsConflict() throws Exception {
        Conversation thread = Conversation.forEvent(openEvent("post-closed-manual"));
        thread.close(Instant.now()); // manual soft-close
        thread = conversations.save(thread);
        activeMember(thread, "cm-member", "tok-cm");

        mockMvc.perform(post("/api/v1/conversations/{id}/messages", thread.getId())
                        .with(user("cm-member"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"too late\"}"))
                .andExpect(status().isConflict());

        assertThat(messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId()))
                .isEmpty();
        assertThat(sender.deliveries()).isEmpty();
    }

    @Test
    void threadPastItsClosePolicyWindowRejectsThePostAsConflict() throws Exception {
        // The event ended an hour ago with a 0-hour close window → the thread is read-only by policy,
        // even though it was never manually soft-closed. Proves the TM-446 close-policy branch is honoured.
        long eventId = eventEndedWithCloseWindow("post-closed-policy", Duration.ofHours(1), 0);
        Conversation thread = conversations.save(Conversation.forEvent(eventId));
        activeMember(thread, "cp-member", "tok-cp");

        mockMvc.perform(post("/api/v1/conversations/{id}/messages", thread.getId())
                        .with(user("cp-member"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"chat's over\"}"))
                .andExpect(status().isConflict());
    }

    // ── length cap + malformed ───────────────────────────────────────────────────────────────────

    @Test
    void blankBodyIsRejectedAsValidationError() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("post-blank")));
        activeMember(thread, "b-member", "tok-b");

        mockMvc.perform(post("/api/v1/conversations/{id}/messages", thread.getId())
                        .with(user("b-member"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"   \"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[0].field").value("body"));
    }

    @Test
    void overLengthBodyIsRejectedAsValidationError() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("post-toolong")));
        activeMember(thread, "l-member", "tok-l");

        String tooLong = "a".repeat(501);
        mockMvc.perform(post("/api/v1/conversations/{id}/messages", thread.getId())
                        .with(user("l-member"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"" + tooLong + "\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[0].field").value("body"));

        assertThat(messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId()))
                .isEmpty();
    }

    // ── unknown thread ───────────────────────────────────────────────────────────────────────────

    @Test
    void unknownThreadIsForbiddenNotFound() throws Exception {
        // TM-573: an unknown/foreign thread is the SAME 403 as a non-member — never a 404 — so a POST
        // can't be used to probe which conversation ids exist (uniform with the GET read gate,
        // ConversationReadIntegrationTest.threadIsMembersOnly).
        provision("u-caller");
        mockMvc.perform(post("/api/v1/conversations/{id}/messages", 9_999_999L)
                        .with(user("u-caller"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"anyone home?\"}"))
                .andExpect(status().isForbidden());
    }

    // ── fixtures ─────────────────────────────────────────────────────────────────────────────────

    /** An authenticated USER principal for {@code uid} — the endpoint resolves the acting member from it. */
    private static RequestPostProcessor user(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of(new SimpleGrantedAuthority("ROLE_USER"))));
    }

    /** Provision (or fetch) a real account for {@code uid}, push-eligible (BOTH), returning its id. */
    private long provision(String uid) {
        User user = users.findByFirebaseUid(uid)
                .orElseGet(() -> users.saveAndFlush(new User(uid, uid + "@example.com", uid)));
        user.setNotificationPref(NotificationPref.BOTH);
        return users.saveAndFlush(user).getId();
    }

    /** An open-ended, future-visible event created by a fresh host; returns its id. */
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

    /** An event that ended {@code endedAgo} ago and auto-closes its chat {@code closeHours} after end. */
    private long eventEndedWithCloseWindow(String heading, Duration endedAgo, int closeHours) {
        Instant now = Instant.now();
        Event event = new Event(
                heading,
                "A finished meetup.",
                "Marhaba Cafe, 12 High St",
                "Europe/London",
                now.minus(endedAgo).minus(Duration.ofHours(2)), // started before it ended
                now.minus(Duration.ofDays(1)),
                now.plus(Duration.ofDays(30)),
                provision(heading + "-host"),
                now);
        event.setEndAt(now.minus(endedAgo));
        event.setChatCloseHours(closeHours);
        return events.save(event).getId();
    }

    /** Add an active ({@code NONE}) member backed by a real push-eligible account + one device token. */
    private long activeMember(Conversation thread, String uid, String token) {
        return member(thread, uid, token, MuteState.NONE);
    }

    /** Add a member in the given mute state, backed by a real account and one push-eligible device token. */
    private long member(Conversation thread, String uid, String token, MuteState mute) {
        long userId = provision(uid);
        ConversationMember m = new ConversationMember(thread.getId(), userId, MemberRole.MEMBER);
        m.setMute(mute);
        members.save(m);
        deviceTokens.saveAndFlush(new DeviceToken(userId, token, DevicePlatform.ANDROID, Instant.now()));
        return userId;
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
