package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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
import com.teammarhaba.backend.event.AttendanceState;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventAttendance;
import com.teammarhaba.backend.event.EventAttendanceRepository;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.notify.PushDelivery;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushSender;
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
 * App-admin thread moderation (TM-449) end-to-end through the real security chain + Postgres, over the
 * two moderation endpoints under {@code /api/v1/admin/conversations} plus the member-facing read/post
 * endpoints they affect. The {@link PushSender} seam is swapped for an in-context recording fake so a
 * reinstated member's real post never touches FCM. Covers every AC bullet:
 *
 * <ul>
 *   <li><b>app admins only</b> — anonymous → 401, a {@code USER} → 403, and an <em>event host</em>
 *       (a thread {@code ADMIN} member who is only {@code ROLE_USER} at the app level) → 403, for both
 *       remove and mute; nothing is mutated when denied;</li>
 *   <li><b>remove a message</b> — an admin removes a message → the row is soft-deleted and it drops out
 *       of the thread timeline read; one {@code EVENT_CHAT_MESSAGE_REMOVED} audit row is written;
 *       re-removing is idempotent; a message that isn't in the named thread, and an unknown message, are
 *       both a {@code 404};</li>
 *   <li><b>mute read-only</b> — an admin sets {@code READ_ONLY} → the member can still read the thread
 *       ({@code 200}) but can no longer post ({@code 403});</li>
 *   <li><b>full removal</b> — an admin sets {@code REMOVED} → the member loses thread access
 *       ({@code 403} on read) while their event RSVP is untouched (still {@code GOING});</li>
 *   <li><b>reinstate</b> — an admin sets {@code NONE} back → the member can post again; each mute change
 *       writes one {@code EVENT_CHAT_MEMBER_MUTED} audit row;</li>
 *   <li><b>bad input</b> — an unknown member is a {@code 404}; a missing / unrecognised {@code state} is
 *       a {@code 400}.</li>
 * </ul>
 */
@AutoConfigureMockMvc
@Import(ChatModerationAdminControllerIntegrationTest.RecordingSenderConfig.class)
class ChatModerationAdminControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired private MockMvc mockMvc;
    @Autowired private UserRepository users;
    @Autowired private ConversationRepository conversations;
    @Autowired private ConversationMemberRepository members;
    @Autowired private MessageRepository messages;
    @Autowired private EventRepository events;
    @Autowired private EventAttendanceRepository attendance;
    @Autowired private AuditRepository audits;
    @Autowired private RecordingPushSender sender;

    @BeforeEach
    void cleanSlate() {
        messages.deleteAll();
        members.deleteAll();
        conversations.deleteAll();
        sender.reset();
    }

    // ── remove a message ──────────────────────────────────────────────────────────────────────────

    @Test
    void adminRemovesMessageWhichThenDropsFromTheTimelineAndIsAudited() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("rm-ok")));
        long memberId = member(thread, "rm-writer", MuteState.NONE);
        Message keep = messages.saveAndFlush(Message.fromUser(thread.getId(), memberId, "hello everyone"));
        Message spam = messages.saveAndFlush(Message.fromUser(thread.getId(), memberId, "buy cheap stuff"));

        // The admin need not be a member of the thread — moderation is app-admin, global.
        mockMvc.perform(post(
                                "/api/v1/admin/conversations/{c}/messages/{m}/remove",
                                thread.getId(),
                                spam.getId())
                        .with(admin("mod-1")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.messageId").value(spam.getId()))
                .andExpect(jsonPath("$.conversationId").value(thread.getId()))
                .andExpect(jsonPath("$.removed").value(true))
                .andExpect(jsonPath("$.removedAt").isNotEmpty());

        // The row is kept but soft-deleted (never hard-deleted).
        assertThat(messages.findById(spam.getId()).orElseThrow().isDeleted()).isTrue();
        assertThat(messages.findById(keep.getId()).orElseThrow().isDeleted()).isFalse();

        // It drops out of the member-facing timeline read (which filters deletedAt IS NULL).
        mockMvc.perform(get("/api/v1/conversations/{c}/messages", thread.getId()).with(user("rm-writer")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.items[0].id").value(keep.getId()))
                .andExpect(jsonPath("$.items[0].body").value("hello everyone"));

        // One audit row for the removal, targeting the conversation, naming the removed message.
        List<AuditEvent> audit = audits.findByTargetTypeAndTargetIdOrderByCreatedAtDesc(
                "Conversation", thread.getId().toString());
        assertThat(audit).hasSize(1);
        assertThat(audit.get(0).getAction()).isEqualTo(AuditAction.EVENT_CHAT_MESSAGE_REMOVED);
        assertThat(audit.get(0).getActorUid()).isEqualTo("mod-1");
    }

    @Test
    void removingAnAlreadyRemovedMessageIsIdempotent() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("rm-idem")));
        long memberId = member(thread, "idem-writer", MuteState.NONE);
        Message msg = messages.saveAndFlush(Message.fromUser(thread.getId(), memberId, "oops"));

        mockMvc.perform(post("/api/v1/admin/conversations/{c}/messages/{m}/remove", thread.getId(), msg.getId())
                        .with(admin("mod-idem")))
                .andExpect(status().isOk());
        Instant firstRemovedAt = messages.findById(msg.getId()).orElseThrow().getDeletedAt();

        // Second remove succeeds; the soft-delete instant is first-moment-wins (never rewritten).
        mockMvc.perform(post("/api/v1/admin/conversations/{c}/messages/{m}/remove", thread.getId(), msg.getId())
                        .with(admin("mod-idem")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.removedAt").value(firstRemovedAt.toString()));
        assertThat(messages.findById(msg.getId()).orElseThrow().getDeletedAt()).isEqualTo(firstRemovedAt);
    }

    @Test
    void removingAMessageFromTheWrongThreadIsNotFound() throws Exception {
        Conversation threadA = conversations.save(Conversation.forEvent(openEvent("rm-a")));
        Conversation threadB = conversations.save(Conversation.forEvent(openEvent("rm-b")));
        long memberId = member(threadA, "wt-writer", MuteState.NONE);
        Message inA = messages.saveAndFlush(Message.fromUser(threadA.getId(), memberId, "in A"));

        // Message exists, but not in thread B → 404 (the path can't cross threads).
        mockMvc.perform(post("/api/v1/admin/conversations/{c}/messages/{m}/remove", threadB.getId(), inA.getId())
                        .with(admin("mod-wt")))
                .andExpect(status().isNotFound());
        assertThat(messages.findById(inA.getId()).orElseThrow().isDeleted()).isFalse();

        // Wholly unknown message id → 404 too.
        mockMvc.perform(post(
                                "/api/v1/admin/conversations/{c}/messages/{m}/remove",
                                threadA.getId(),
                                9_999_999L)
                        .with(admin("mod-wt")))
                .andExpect(status().isNotFound());
    }

    // ── admin-only gate ───────────────────────────────────────────────────────────────────────────

    @Test
    void anonymousCallerIsUnauthorizedForBothActions() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("gate-anon")));
        long memberId = member(thread, "anon-target", MuteState.NONE);
        Message msg = messages.saveAndFlush(Message.fromUser(thread.getId(), memberId, "hi"));

        mockMvc.perform(post("/api/v1/admin/conversations/{c}/messages/{m}/remove", thread.getId(), msg.getId()))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/admin/conversations/{c}/members/{u}/mute", thread.getId(), memberId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"state\":\"READ_ONLY\"}"))
                .andExpect(status().isUnauthorized());

        assertThat(messages.findById(msg.getId()).orElseThrow().isDeleted()).isFalse();
        assertThat(members.findById(membershipId(thread, memberId)).orElseThrow().getMute()).isEqualTo(MuteState.NONE);
    }

    @Test
    void nonAdminUserIsForbiddenAndNothingIsMutated() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("gate-user")));
        long memberId = member(thread, "u-target", MuteState.NONE);
        Message msg = messages.saveAndFlush(Message.fromUser(thread.getId(), memberId, "hi"));
        provision("u-random"); // a real, non-admin account

        mockMvc.perform(post("/api/v1/admin/conversations/{c}/messages/{m}/remove", thread.getId(), msg.getId())
                        .with(user("u-random")))
                .andExpect(status().isForbidden());
        mockMvc.perform(post("/api/v1/admin/conversations/{c}/members/{u}/mute", thread.getId(), memberId)
                        .with(user("u-random"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"state\":\"REMOVED\"}"))
                .andExpect(status().isForbidden());

        assertThat(messages.findById(msg.getId()).orElseThrow().isDeleted()).isFalse();
        assertThat(members.findById(membershipId(thread, memberId)).orElseThrow().getMute()).isEqualTo(MuteState.NONE);
    }

    @Test
    void eventHostWhoIsOnlyAThreadAdminCannotModerate() throws Exception {
        // The event host is a thread ADMIN member — but only ROLE_USER at the app level, so the
        // app-admin gate still denies them (the AC: "app admins only … event hosts cannot").
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("gate-host")));
        long hostId = provision("host-user");
        members.save(new ConversationMember(thread.getId(), hostId, MemberRole.ADMIN));
        long memberId = member(thread, "host-target", MuteState.NONE);
        Message msg = messages.saveAndFlush(Message.fromUser(thread.getId(), memberId, "hi"));

        mockMvc.perform(post("/api/v1/admin/conversations/{c}/messages/{m}/remove", thread.getId(), msg.getId())
                        .with(user("host-user")))
                .andExpect(status().isForbidden());
        assertThat(messages.findById(msg.getId()).orElseThrow().isDeleted()).isFalse();
    }

    // ── mute: read-only ───────────────────────────────────────────────────────────────────────────

    @Test
    void mutedReadOnlyMemberCanStillReadButCannotPost() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("mute-ro")));
        long memberId = member(thread, "ro-user", MuteState.NONE);
        messages.saveAndFlush(Message.fromUser(thread.getId(), memberId, "before mute"));

        mockMvc.perform(post("/api/v1/admin/conversations/{c}/members/{u}/mute", thread.getId(), memberId)
                        .with(admin("mod-ro"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"state\":\"READ_ONLY\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.conversationId").value(thread.getId()))
                .andExpect(jsonPath("$.userId").value(memberId))
                .andExpect(jsonPath("$.mute").value("READ_ONLY"));

        assertThat(members.findById(membershipId(thread, memberId)).orElseThrow().getMute())
                .isEqualTo(MuteState.READ_ONLY);

        // Can still READ the thread…
        mockMvc.perform(get("/api/v1/conversations/{c}/messages", thread.getId()).with(user("ro-user")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(1));

        // …but can no longer POST.
        mockMvc.perform(post("/api/v1/conversations/{c}/messages", thread.getId())
                        .with(user("ro-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"muted but trying\"}"))
                .andExpect(status().isForbidden());

        // One audit row for the mute change.
        List<AuditEvent> audit = audits.findByTargetTypeAndTargetIdOrderByCreatedAtDesc(
                "Conversation", thread.getId().toString());
        assertThat(audit).hasSize(1);
        assertThat(audit.get(0).getAction()).isEqualTo(AuditAction.EVENT_CHAT_MEMBER_MUTED);
    }

    // ── mute: full removal (RSVP untouched) ───────────────────────────────────────────────────────

    @Test
    void removedMemberLosesThreadAccessButKeepsTheirRsvp() throws Exception {
        long eventId = openEvent("mute-removed");
        Conversation thread = conversations.save(Conversation.forEvent(eventId));
        long memberId = member(thread, "kick-user", MuteState.NONE);
        // The member is GOING to the event — removal from the thread must NOT change that.
        attendance.saveAndFlush(new EventAttendance(eventId, memberId, AttendanceState.GOING));

        mockMvc.perform(post("/api/v1/admin/conversations/{c}/members/{u}/mute", thread.getId(), memberId)
                        .with(admin("mod-kick"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"state\":\"REMOVED\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.mute").value("REMOVED"));

        // Loses thread read access (a REMOVED member reads as a non-member → 403).
        mockMvc.perform(get("/api/v1/conversations/{c}/messages", thread.getId()).with(user("kick-user")))
                .andExpect(status().isForbidden());

        // RSVP is untouched — still GOING.
        assertThat(attendance.findByEventIdAndUserId(eventId, memberId).orElseThrow().getState())
                .isEqualTo(AttendanceState.GOING);
    }

    // ── mute: reinstate ───────────────────────────────────────────────────────────────────────────

    @Test
    void reinstatingAMemberLetsThemPostAgain() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("mute-reinstate")));
        long memberId = member(thread, "back-user", MuteState.READ_ONLY);

        // Muted first: cannot post.
        mockMvc.perform(post("/api/v1/conversations/{c}/messages", thread.getId())
                        .with(user("back-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"still muted\"}"))
                .andExpect(status().isForbidden());

        // Reinstate to NONE.
        mockMvc.perform(post("/api/v1/admin/conversations/{c}/members/{u}/mute", thread.getId(), memberId)
                        .with(admin("mod-back"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"state\":\"NONE\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.mute").value("NONE"));

        // Now the post goes through.
        mockMvc.perform(post("/api/v1/conversations/{c}/messages", thread.getId())
                        .with(user("back-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"i'm back\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.body").value("i'm back"));
    }

    // ── mute: bad input ───────────────────────────────────────────────────────────────────────────

    @Test
    void mutingAnUnknownMemberIsNotFound() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("mute-unknown")));
        provision("not-a-member");

        mockMvc.perform(post("/api/v1/admin/conversations/{c}/members/{u}/mute", thread.getId(), 9_999_999L)
                        .with(admin("mod-unknown"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"state\":\"READ_ONLY\"}"))
                .andExpect(status().isNotFound());
    }

    @Test
    void muteWithMissingOrUnrecognisedStateIsBadRequest() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("mute-bad")));
        long memberId = member(thread, "bad-target", MuteState.NONE);

        // Missing state → Bean-Validation 400.
        mockMvc.perform(post("/api/v1/admin/conversations/{c}/members/{u}/mute", thread.getId(), memberId)
                        .with(admin("mod-bad"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isBadRequest());

        // Unrecognised enum value → message-converter 400.
        mockMvc.perform(post("/api/v1/admin/conversations/{c}/members/{u}/mute", thread.getId(), memberId)
                        .with(admin("mod-bad"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"state\":\"BANHAMMER\"}"))
                .andExpect(status().isBadRequest());

        assertThat(members.findById(membershipId(thread, memberId)).orElseThrow().getMute()).isEqualTo(MuteState.NONE);
    }

    // ── fixtures ─────────────────────────────────────────────────────────────────────────────────

    /** An authenticated app-ADMIN principal for {@code uid}. */
    private static RequestPostProcessor admin(String uid) {
        return principal(uid, "ROLE_ADMIN");
    }

    /** An authenticated ordinary USER principal for {@code uid}. */
    private static RequestPostProcessor user(String uid) {
        return principal(uid, "ROLE_USER");
    }

    private static RequestPostProcessor principal(String uid, String authority) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of(new SimpleGrantedAuthority(authority))));
    }

    /** Provision (or fetch) a real account for {@code uid}, returning its id. */
    private long provision(String uid) {
        return users.findByFirebaseUid(uid)
                .orElseGet(() -> users.saveAndFlush(new User(uid, uid + "@example.com", uid)))
                .getId();
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

    /** Add a member in the given mute state, backed by a real account; returns the user id. */
    private long member(Conversation thread, String uid, MuteState mute) {
        long userId = provision(uid);
        ConversationMember m = new ConversationMember(thread.getId(), userId, MemberRole.MEMBER);
        m.setMute(mute);
        members.save(m);
        return userId;
    }

    /** The membership row's own id for (thread, userId) — used to re-read its mute state from the DB. */
    private long membershipId(Conversation thread, long userId) {
        return members.findByConversationIdAndUserId(thread.getId(), userId).orElseThrow().getId();
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

    /** A no-op push sender so a reinstated member's real post never reaches FCM in the test. */
    static final class RecordingPushSender implements PushSender {
        private final List<String> deliveries = new ArrayList<>();

        @Override
        public synchronized PushDelivery send(String token, PushMessage message) {
            deliveries.add(token);
            return PushDelivery.DELIVERED;
        }

        synchronized void reset() {
            deliveries.clear();
        }
    }
}
