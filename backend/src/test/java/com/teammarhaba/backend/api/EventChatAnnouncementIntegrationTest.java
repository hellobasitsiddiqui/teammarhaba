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
import com.teammarhaba.backend.chat.MessageKind;
import com.teammarhaba.backend.chat.MessageRepository;
import com.teammarhaba.backend.chat.MuteState;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * TM-710 admin announcement post path {@code POST /api/v1/conversations/{id}/announcements} end-to-end
 * through the real security chain + Postgres. Covers the AC:
 *
 * <ul>
 *   <li><b>admin-send FIX (fail-before / pass-after)</b> — a global admin who is NEITHER the host NOR a
 *       GOING attendee has no {@code conversation_member} row. Through the ordinary member-gated post
 *       endpoint they are {@code 403} (the bug this ticket fixes — asserted here as the "fail-before"
 *       baseline). Through the new announcement endpoint they post successfully as an announcement (the
 *       "pass-after");</li>
 *   <li><b>announcement kind + attribution</b> — the created message is {@code kind == ANNOUNCEMENT}
 *       and persisted as such, distinct from an attendee post;</li>
 *   <li><b>server-side admin gate</b> — a non-admin hitting the announcement endpoint is a uniform
 *       {@code 403} (method security, not just UI), and nothing is persisted;</li>
 *   <li><b>closed thread</b> — a soft-closed thread rejects the announcement as {@code 409};</li>
 *   <li><b>unknown thread</b> — a {@code 404} for the admin (no attendee to probe ids).</li>
 * </ul>
 */
@AutoConfigureMockMvc
class EventChatAnnouncementIntegrationTest extends AbstractIntegrationTest {

    @Autowired private MockMvc mockMvc;
    @Autowired private UserRepository users;
    @Autowired private ConversationRepository conversations;
    @Autowired private ConversationMemberRepository members;
    @Autowired private MessageRepository messages;
    @Autowired private EventRepository events;
    @Autowired private AuditRepository audits;

    @BeforeEach
    void cleanSlate() {
        messages.deleteAll();
        members.deleteAll();
        conversations.deleteAll();
    }

    // ── admin-send fix: fail-before (member-gated post) / pass-after (announcement endpoint) ─────────

    @Test
    void nonAttendeeAdminIsForbiddenOnTheOrdinaryPostEndpoint_failBefore() throws Exception {
        // Baseline: the ORDINARY post is member-gated. An admin who doesn't attend has no membership row,
        // so they are 403 — the admin-send gap TM-710 fixes.
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("ann-failbefore")));
        provisionAdmin("ann-admin-fb");

        mockMvc.perform(post("/api/v1/conversations/{id}/messages", thread.getId())
                        .with(admin("ann-admin-fb"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"admin trying the normal composer\"}"))
                .andExpect(status().isForbidden());

        assertThat(messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId()))
                .isEmpty();
    }

    @Test
    void nonAttendeeAdminPostsAnAnnouncement_passAfter() throws Exception {
        // Same non-attendee admin, same thread — now via the announcement endpoint: it succeeds and
        // renders as an ANNOUNCEMENT.
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("ann-passafter")));
        long adminId = provisionAdmin("ann-admin-pa");

        mockMvc.perform(post("/api/v1/conversations/{id}/announcements", thread.getId())
                        .with(admin("ann-admin-pa"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"Doors open at 7pm — see you there!\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.kind").value("ANNOUNCEMENT"))
                .andExpect(jsonPath("$.senderId").value((int) adminId))
                .andExpect(jsonPath("$.body").value("Doors open at 7pm — see you there!"));

        List<Message> stored = messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(
                thread.getId());
        assertThat(stored).hasSize(1);
        assertThat(stored.get(0).getKind()).isEqualTo(MessageKind.ANNOUNCEMENT);
        assertThat(stored.get(0).getSenderId()).isEqualTo(adminId);

        List<AuditEvent> audit = audits.findByTargetTypeAndTargetIdOrderByCreatedAtDesc(
                "Conversation", thread.getId().toString());
        assertThat(audit).hasSize(1);
        assertThat(audit.get(0).getAction()).isEqualTo(AuditAction.EVENT_CHAT_ANNOUNCEMENT_POSTED);
    }

    // ── server-side admin gate ──────────────────────────────────────────────────────────────────────

    @Test
    void nonAdminCannotPostAnAnnouncement() throws Exception {
        // A normal attendee — even an active member of the thread — cannot post an ANNOUNCEMENT: the
        // endpoint is method-secured to ROLE_ADMIN, so it's a uniform 403 (server-side, not just UI).
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("ann-nonadmin")));
        activeMember(thread, "ann-attendee");

        mockMvc.perform(post("/api/v1/conversations/{id}/announcements", thread.getId())
                        .with(user("ann-attendee"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"I'm not an admin\"}"))
                .andExpect(status().isForbidden());

        assertThat(messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId()))
                .isEmpty();
    }

    // ── conversation type gate (TM-856) ─────────────────────────────────────────────────────────────

    @Test
    void announcementToAnAdminBroadcastChannelIsRejected() throws Exception {
        // TM-856: an ANNOUNCEMENT belongs only in an EVENT_GROUP thread. An admin must NOT be able to
        // inject a human-sender announcement into a user's private ADMIN_BROADCAST channel (whose
        // messages are system-sent) — the type gate rejects it as a 400 and nothing is persisted.
        long ownerId = provision("ann-broadcast-owner");
        Conversation channel = conversations.save(Conversation.adminBroadcast(ownerId));
        provisionAdmin("ann-admin-broadcast");

        mockMvc.perform(post("/api/v1/conversations/{id}/announcements", channel.getId())
                        .with(admin("ann-admin-broadcast"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"sneaking into your inbox\"}"))
                .andExpect(status().isBadRequest());

        assertThat(messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(channel.getId()))
                .isEmpty();
    }

    // ── closed / unknown thread ─────────────────────────────────────────────────────────────────────

    @Test
    void announcementToAClosedThreadIsConflict() throws Exception {
        Conversation thread = Conversation.forEvent(openEvent("ann-closed"));
        thread.close(Instant.now());
        thread = conversations.save(thread);
        provisionAdmin("ann-admin-closed");

        mockMvc.perform(post("/api/v1/conversations/{id}/announcements", thread.getId())
                        .with(admin("ann-admin-closed"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"too late\"}"))
                .andExpect(status().isConflict());
    }

    @Test
    void announcementToAnUnknownThreadIsNotFound() throws Exception {
        provisionAdmin("ann-admin-unknown");
        mockMvc.perform(post("/api/v1/conversations/{id}/announcements", 9_999_999L)
                        .with(admin("ann-admin-unknown"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"nobody home\"}"))
                .andExpect(status().isNotFound());
    }

    @Test
    void blankAnnouncementBodyIsValidationError() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("ann-blank")));
        provisionAdmin("ann-admin-blank");

        mockMvc.perform(post("/api/v1/conversations/{id}/announcements", thread.getId())
                        .with(admin("ann-admin-blank"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"   \"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[0].field").value("body"));
    }

    // ── fixtures ────────────────────────────────────────────────────────────────────────────────────

    private static RequestPostProcessor user(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of(new SimpleGrantedAuthority("ROLE_USER"))));
    }

    private static RequestPostProcessor admin(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of(new SimpleGrantedAuthority("ROLE_ADMIN"))));
    }

    private long provision(String uid) {
        return users.findByFirebaseUid(uid)
                .orElseGet(() -> users.saveAndFlush(new User(uid, uid + "@example.com", uid)))
                .getId();
    }

    /** Provision an account for an admin caller (the ROLE_ADMIN principal carries the authorization). */
    private long provisionAdmin(String uid) {
        return provision(uid);
    }

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

    private long activeMember(Conversation thread, String uid) {
        long userId = provision(uid);
        ConversationMember m = new ConversationMember(thread.getId(), userId, MemberRole.MEMBER);
        m.setMute(MuteState.NONE);
        members.save(m);
        return userId;
    }
}
