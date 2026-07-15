package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.chat.ChatModerationService;
import com.teammarhaba.backend.chat.ChatStreamService;
import com.teammarhaba.backend.chat.Conversation;
import com.teammarhaba.backend.chat.ConversationMember;
import com.teammarhaba.backend.chat.ConversationMemberRepository;
import com.teammarhaba.backend.chat.ConversationRepository;
import com.teammarhaba.backend.chat.MemberRole;
import com.teammarhaba.backend.chat.Message;
import com.teammarhaba.backend.chat.MessageAuthorService;
import com.teammarhaba.backend.chat.MessageRepository;
import com.teammarhaba.backend.chat.MuteState;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.notify.PushDelivery;
import com.teammarhaba.backend.notify.PushSender;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Duration;
import java.time.Instant;
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
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * TM-738 P0 (admin) — a CHARACTERIZATION / regression test that <b>pins</b> an existing, deliberate
 * asymmetry between the two soft-delete paths that both stamp {@link Message#softDelete}, so a later
 * refactor can't quietly collapse them (the TM-738 dedup note explicitly asks the two pinned behaviours
 * to be co-authored so they never contradict):
 *
 * <ul>
 *   <li><b>Admin moderation removal</b> ({@link ChatModerationService#removeMessage}) emits <b>NO</b>
 *       live SSE {@code message-deleted} frame — it soft-deletes the row + audits, but publishes no
 *       {@link com.teammarhaba.backend.chat.MessageDeletedEvent}, so
 *       {@link com.teammarhaba.backend.chat.MessageMutationStreamListener} never broadcasts. A connected
 *       member re-syncs on their next poll / reconnect (the read filters {@code deletedAt IS NULL}), so
 *       the removal is not lossy — it simply doesn't ride the author-edit/delete live channel.</li>
 *   <li><b>Author self-delete</b> ({@link MessageAuthorService#deleteOwnMessage}) <b>DOES</b> emit a
 *       live {@code message-deleted} frame — it publishes the domain event the listener consumes
 *       {@code AFTER_COMMIT} and broadcasts (TM-467). This is the contrast that makes the pin above a
 *       real, meaningful assertion rather than a vacuous "nothing streams".</li>
 * </ul>
 *
 * <p>End-to-end through the real Postgres + SSE hub: a listener opens a live stream (async, registered
 * on the hub exactly as {@link ConversationStreamIntegrationTest} does), then the mutation is driven
 * through the real {@code @Transactional} service method — so its {@code AFTER_COMMIT} listener actually
 * fires (or, for moderation, is never even wired) — and the streamed bytes are asserted. The
 * {@link PushSender} seam is a no-op so no path touches real FCM.
 */
@AutoConfigureMockMvc
@Import(ChatModerationRemoveMessageStreamPinIntegrationTest.NoopSenderConfig.class)
class ChatModerationRemoveMessageStreamPinIntegrationTest extends AbstractIntegrationTest {

    @Autowired private MockMvc mockMvc;
    @Autowired private UserRepository users;
    @Autowired private ConversationRepository conversations;
    @Autowired private ConversationMemberRepository members;
    @Autowired private MessageRepository messages;
    @Autowired private EventRepository events;
    @Autowired private ChatStreamService chatStreamService;
    @Autowired private ChatModerationService chatModerationService;
    @Autowired private MessageAuthorService messageAuthorService;

    @BeforeEach
    void cleanSlate() {
        messages.deleteAll();
        members.deleteAll();
        conversations.deleteAll();
    }

    /**
     * The pin: an admin moderation removal soft-deletes the message but emits NO live {@code
     * message-deleted} SSE frame — while an author's own delete of an equivalent message on an equivalent
     * live stream DOES. Both branches run against a genuinely-connected listener so "no frame" means the
     * broadcast truly never happened, not that nobody was listening.
     */
    @Test
    void removeMessageNoSseDeleteFrameBehaviourPinned() throws Exception {
        // ── branch A: admin moderation removal emits NO live message-deleted frame ──────────────────────
        Conversation modThread = conversations.save(Conversation.forEvent(openEvent("pin-mod")));
        long authorId = member(modThread, "pin-mod-author", MuteState.NONE);
        activeMember(modThread, "pin-mod-listener"); // a real member who opens the live stream

        Message spam = messages.saveAndFlush(Message.fromUser(modThread.getId(), authorId, "buy cheap stuff"));

        // The listener opens the SSE stream (async) and it registers on the hub — a genuinely-connected member.
        MvcResult modStream = mockMvc.perform(get("/api/v1/conversations/{id}/stream", modThread.getId())
                        .accept(MediaType.TEXT_EVENT_STREAM)
                        .with(user("pin-mod-listener")))
                .andExpect(request().asyncStarted())
                .andReturn();
        assertThat(chatStreamService.connectionCount(modThread.getId())).isEqualTo(1);

        // Admin removes the message through the real @Transactional service — any AFTER_COMMIT listener
        // would fire on this commit (proven by ConversationStreamIntegrationTest's revoke test). It doesn't,
        // because moderation publishes no MessageDeletedEvent.
        chatModerationService.removeMessage(
                new VerifiedUser("pin-mod-admin", "pin-mod-admin@example.com"), modThread.getId(), spam.getId());

        // The row IS soft-deleted (the removal happened) …
        assertThat(messages.findById(spam.getId()).orElseThrow().isDeleted()).isTrue();
        // … but the connected listener received NO message-deleted frame (the pin: moderation is silent on SSE).
        String modStreamed = modStream.getResponse().getContentAsString();
        assertThat(modStreamed)
                .as("admin moderation removal must NOT emit a live message-deleted SSE frame")
                .doesNotContain("event:" + ChatStreamService.EVENT_MESSAGE_DELETED)
                .doesNotContain(ChatStreamService.EVENT_MESSAGE_DELETED);

        // ── branch B: author self-delete DOES emit a live message-deleted frame (the contrast) ─────────
        Conversation authThread = conversations.save(Conversation.forEvent(openEvent("pin-auth")));
        long selfAuthorId = member(authThread, "pin-auth-author", MuteState.NONE);
        activeMember(authThread, "pin-auth-listener");

        Message own = messages.saveAndFlush(Message.fromUser(authThread.getId(), selfAuthorId, "my own message"));

        MvcResult authStream = mockMvc.perform(get("/api/v1/conversations/{id}/stream", authThread.getId())
                        .accept(MediaType.TEXT_EVENT_STREAM)
                        .with(user("pin-auth-listener")))
                .andExpect(request().asyncStarted())
                .andReturn();
        assertThat(chatStreamService.connectionCount(authThread.getId())).isEqualTo(1);

        // The author deletes their own message through the real @Transactional author service — it publishes
        // MessageDeletedEvent, which MessageMutationStreamListener broadcasts AFTER_COMMIT.
        messageAuthorService.deleteOwnMessage(
                new VerifiedUser("pin-auth-author", "pin-auth-author@example.com"),
                authThread.getId(),
                own.getId());

        assertThat(messages.findById(own.getId()).orElseThrow().isDeleted()).isTrue();
        String authStreamed = authStream.getResponse().getContentAsString();
        assertThat(authStreamed)
                .as("author self-delete DOES emit a live message-deleted SSE frame")
                .contains("event:" + ChatStreamService.EVENT_MESSAGE_DELETED)
                .contains("\"messageId\":" + own.getId());
    }

    // ── fixtures (mirrors ConversationStreamIntegrationTest / ChatModerationAdminControllerIntegrationTest) ──

    /** An authenticated USER principal for {@code uid} — the stream endpoint resolves the member from it. */
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

    /** Add an active (unmuted) member backed by a real account; returns the user id. */
    private long activeMember(Conversation thread, String uid) {
        return member(thread, uid, MuteState.NONE);
    }

    /** Add a member in the given mute state, backed by a real account; returns the user id. */
    private long member(Conversation thread, String uid, MuteState mute) {
        long userId = provision(uid);
        ConversationMember m = new ConversationMember(thread.getId(), userId, MemberRole.MEMBER);
        m.setMute(mute);
        members.save(m);
        return userId;
    }

    // ── harness ──────────────────────────────────────────────────────────────────────────────────────

    /** A no-op push transport so no delete/removal path touches real FCM — this test is about the socket. */
    @TestConfiguration
    static class NoopSenderConfig {
        @Bean
        @Primary
        PushSender noopPushSender() {
            return (token, message) -> PushDelivery.DELIVERED;
        }
    }
}
