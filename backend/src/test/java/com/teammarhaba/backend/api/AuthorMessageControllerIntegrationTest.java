package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
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
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The author self-service edit/delete endpoints (TM-467) end-to-end through the real security chain +
 * Postgres:
 *
 * <ul>
 *   <li>{@code PATCH /api/v1/conversations/{id}/messages/{messageId}} — edit your OWN message;</li>
 *   <li>{@code DELETE /api/v1/conversations/{id}/messages/{messageId}} — delete your OWN message.</li>
 * </ul>
 *
 * Covers every AC bullet: the author can edit (body rewritten + {@code editedAt} stamped) and delete
 * (soft-deleted, drops from the timeline) their own message; a non-author is a uniform {@code 403} on
 * both (owner-scoped); an edit on a closed thread is a {@code 409}; an edit past the ~5-minute window is
 * a {@code 409} (the window is enforced server-side against the DB-authoritative {@code created_at},
 * which the test backdates); a blank edit body is a {@code 400}; delete is allowed anytime (even on a
 * closed thread and past the window); and an audit row is written for each. The window test backdates
 * {@code created_at} directly in the DB (a native update) rather than sleeping, so it's deterministic.
 */
@AutoConfigureMockMvc
class AuthorMessageControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired private MockMvc mockMvc;
    @Autowired private UserRepository users;
    @Autowired private ConversationRepository conversations;
    @Autowired private ConversationMemberRepository members;
    @Autowired private MessageRepository messages;
    @Autowired private EventRepository events;
    @Autowired private AuditRepository audits;
    @Autowired private JdbcTemplate jdbc;

    @BeforeEach
    void cleanSlate() {
        messages.deleteAll();
        members.deleteAll();
        conversations.deleteAll();
    }

    // ── edit: happy path ─────────────────────────────────────────────────────────────────────────

    @Test
    void authorEditsOwnRecentMessageWithinWindow() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("edit-ok")));
        long authorId = activeMember(thread, "e-author"); // the message's author + caller
        long messageId = messages.saveAndFlush(Message.fromUser(thread.getId(), authorId, "helo team")).getId();

        mockMvc.perform(patch("/api/v1/conversations/{id}/messages/{mid}", thread.getId(), messageId)
                        .with(user("e-author"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"hello team\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value((int) messageId))
                .andExpect(jsonPath("$.body").value("hello team")) // body rewritten
                .andExpect(jsonPath("$.editedAt").isNotEmpty()) // edited marker stamped
                .andExpect(jsonPath("$.mine").value(true));

        // Persisted: body changed in place, editedAt set, still live.
        Message stored = messages.findById(messageId).orElseThrow();
        assertThat(stored.getBody()).isEqualTo("hello team");
        assertThat(stored.getEditedAt()).isNotNull();
        assertThat(stored.isDeleted()).isFalse();

        // One EVENT_CHAT_MESSAGE_EDITED audit row against the conversation.
        List<AuditEvent> audit = audits.findByTargetTypeAndTargetIdOrderByCreatedAtDesc(
                "Conversation", thread.getId().toString());
        assertThat(audit).hasSize(1);
        assertThat(audit.get(0).getAction()).isEqualTo(AuditAction.EVENT_CHAT_MESSAGE_EDITED);
    }

    @Test
    void blankEditBodyIsRejectedAsValidationError() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("edit-blank")));
        long authorId = activeMember(thread, "eb-author");
        long messageId = messages.saveAndFlush(Message.fromUser(thread.getId(), authorId, "keep me")).getId();

        mockMvc.perform(patch("/api/v1/conversations/{id}/messages/{mid}", thread.getId(), messageId)
                        .with(user("eb-author"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"   \"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[0].field").value("body"));

        assertThat(messages.findById(messageId).orElseThrow().getBody()).isEqualTo("keep me");
    }

    // ── edit: owner gate ─────────────────────────────────────────────────────────────────────────

    @Test
    void nonAuthorCannotEditAndGets403() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("edit-403")));
        long authorId = activeMember(thread, "ea-author");
        activeMember(thread, "ea-other"); // a fellow member — but not the author
        long messageId = messages.saveAndFlush(Message.fromUser(thread.getId(), authorId, "author's words")).getId();

        mockMvc.perform(patch("/api/v1/conversations/{id}/messages/{mid}", thread.getId(), messageId)
                        .with(user("ea-other"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"not my message\"}"))
                .andExpect(status().isForbidden());

        assertThat(messages.findById(messageId).orElseThrow().getBody()).isEqualTo("author's words");
    }

    @Test
    void editingAMessageInAnotherThreadIs404() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("edit-foreign")));
        long authorId = activeMember(thread, "ef-author");
        // A message the author DOES own, but in a DIFFERENT thread — the {id}/{messageId} path must not
        // reach across threads (a plain 404, uniform with a made-up id).
        Conversation other = conversations.save(Conversation.forEvent(openEvent("edit-foreign-other")));
        long foreign = messages.saveAndFlush(Message.fromUser(other.getId(), authorId, "over there")).getId();

        mockMvc.perform(patch("/api/v1/conversations/{id}/messages/{mid}", thread.getId(), foreign)
                        .with(user("ef-author"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"wrong thread\"}"))
                .andExpect(status().isNotFound());
    }

    // ── edit: closed-thread + window gates (both 409) ────────────────────────────────────────────

    @Test
    void editOnAClosedThreadIsConflict() throws Exception {
        Conversation thread = Conversation.forEvent(openEvent("edit-closed"));
        thread.close(Instant.now()); // manual soft-close
        thread = conversations.save(thread);
        long authorId = activeMember(thread, "ec-author");
        long messageId = messages.saveAndFlush(Message.fromUser(thread.getId(), authorId, "before close")).getId();

        mockMvc.perform(patch("/api/v1/conversations/{id}/messages/{mid}", thread.getId(), messageId)
                        .with(user("ec-author"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"too late to edit\"}"))
                .andExpect(status().isConflict());

        assertThat(messages.findById(messageId).orElseThrow().getBody()).isEqualTo("before close");
    }

    @Test
    void editPastTheEditWindowIsConflict() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("edit-window")));
        long authorId = activeMember(thread, "ew-author");
        long messageId = messages.saveAndFlush(Message.fromUser(thread.getId(), authorId, "old message")).getId();
        // Backdate created_at 6 minutes into the past (> the ~5-minute window) directly in the DB, so the
        // server-side window check (against the DB-authoritative created_at) sees the message as locked.
        backdateCreatedAt(messageId, Instant.now().minus(Duration.ofMinutes(6)));

        mockMvc.perform(patch("/api/v1/conversations/{id}/messages/{mid}", thread.getId(), messageId)
                        .with(user("ew-author"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"body\":\"editing too late\"}"))
                .andExpect(status().isConflict());

        Message stored = messages.findById(messageId).orElseThrow();
        assertThat(stored.getBody()).isEqualTo("old message");
        assertThat(stored.getEditedAt()).isNull();
    }

    // ── delete: happy path + owner gate + anytime ────────────────────────────────────────────────

    @Test
    void authorDeletesOwnMessageWhichDropsFromTheTimeline() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("del-ok")));
        long authorId = activeMember(thread, "d-author");
        long messageId = messages.saveAndFlush(Message.fromUser(thread.getId(), authorId, "delete me")).getId();

        mockMvc.perform(delete("/api/v1/conversations/{id}/messages/{mid}", thread.getId(), messageId)
                        .with(user("d-author")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.messageId").value((int) messageId))
                .andExpect(jsonPath("$.removed").value(true))
                .andExpect(jsonPath("$.removedAt").isNotEmpty());

        // Soft-deleted (row kept, deletedAt stamped) → dropped from every timeline read.
        Message stored = messages.findById(messageId).orElseThrow();
        assertThat(stored.isDeleted()).isTrue();
        assertThat(messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId()))
                .isEmpty();

        List<AuditEvent> audit = audits.findByTargetTypeAndTargetIdOrderByCreatedAtDesc(
                "Conversation", thread.getId().toString());
        assertThat(audit).hasSize(1);
        assertThat(audit.get(0).getAction()).isEqualTo(AuditAction.EVENT_CHAT_MESSAGE_DELETED);
    }

    @Test
    void nonAuthorCannotDeleteAndGets403() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("del-403")));
        long authorId = activeMember(thread, "da-author");
        activeMember(thread, "da-other");
        long messageId = messages.saveAndFlush(Message.fromUser(thread.getId(), authorId, "not yours")).getId();

        mockMvc.perform(delete("/api/v1/conversations/{id}/messages/{mid}", thread.getId(), messageId)
                        .with(user("da-other")))
                .andExpect(status().isForbidden());

        assertThat(messages.findById(messageId).orElseThrow().isDeleted()).isFalse();
    }

    @Test
    void authorCanDeleteAnytimeEvenOnAClosedThreadAndPastTheWindow() throws Exception {
        // Delete has NO open-thread or window gate (the AC: "delete allowed anytime"). A closed thread +
        // a long-past created_at would both block an EDIT, but a delete still succeeds.
        Conversation thread = Conversation.forEvent(openEvent("del-anytime"));
        thread.close(Instant.now());
        thread = conversations.save(thread);
        long authorId = activeMember(thread, "dt-author");
        long messageId = messages.saveAndFlush(Message.fromUser(thread.getId(), authorId, "old + closed")).getId();
        backdateCreatedAt(messageId, Instant.now().minus(Duration.ofDays(1)));

        mockMvc.perform(delete("/api/v1/conversations/{id}/messages/{mid}", thread.getId(), messageId)
                        .with(user("dt-author")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.removed").value(true));

        assertThat(messages.findById(messageId).orElseThrow().isDeleted()).isTrue();
    }

    @Test
    void deletingAnAlreadyDeletedMessageIs404() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("del-gone")));
        long authorId = activeMember(thread, "dg-author");
        Message message = messages.saveAndFlush(Message.fromUser(thread.getId(), authorId, "gone"));
        message.softDelete(Instant.now());
        messages.saveAndFlush(message);

        // A soft-deleted message is not a live message of the thread → the same 404 a missing id returns.
        mockMvc.perform(delete("/api/v1/conversations/{id}/messages/{mid}", thread.getId(), message.getId())
                        .with(user("dg-author")))
                .andExpect(status().isNotFound());
    }

    // ── fixtures ─────────────────────────────────────────────────────────────────────────────────

    /** An authenticated USER principal for {@code uid} — the endpoint resolves the acting member from it. */
    private static RequestPostProcessor user(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of(new SimpleGrantedAuthority("ROLE_USER"))));
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

    /** Add an active ({@code NONE}) member backed by a real account; returns their user id. */
    private long activeMember(Conversation thread, String uid) {
        long userId = provision(uid);
        members.save(new ConversationMember(thread.getId(), userId, MemberRole.MEMBER));
        return userId;
    }

    /** Backdate a message's DB-authoritative {@code created_at} so the edit-window check can be tested. */
    private void backdateCreatedAt(long messageId, Instant when) {
        jdbc.update("UPDATE message SET created_at = ? WHERE id = ?", Timestamp.from(when), messageId);
    }
}
