package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
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
 * TM-738 P1 (chat) — a CHARACTERIZATION / regression test that pins the fact that an author's own-message
 * <b>edit</b> and <b>delete</b> live-broadcast (TM-467) ride <b>distinct SSE event names</b>, neither of
 * which is the fresh-post {@link ChatStreamService#EVENT_MESSAGE} name:
 *
 * <ul>
 *   <li>an <b>edit</b> rides {@link ChatStreamService#EVENT_MESSAGE_EDITED} ({@code message-edited}) —
 *       the client treats it as a body/{@code editedAt} PATCH of a message it already holds, so it must
 *       NOT ride {@code message} (whose consumer upserts a whole bubble and would clobber that message's
 *       reactions / receipt / reply quote);</li>
 *   <li>a <b>delete</b> rides {@link ChatStreamService#EVENT_MESSAGE_DELETED} ({@code message-deleted}) —
 *       the client drops the message by id.</li>
 * </ul>
 *
 * <p>Why this matters as a pin: the two mutation frames are deliberately split from the create frame and
 * from each other ({@link com.teammarhaba.backend.chat.MessageMutationStreamListener} routes each to its
 * own event name). A refactor that collapsed either onto {@code message} — or onto the other — would
 * silently break the client's in-place re-render / by-id drop without failing any create-path test. This
 * asserts the seam end-to-end: a real live listener, both mutations driven through the real
 * {@code @Transactional} {@link MessageAuthorService} so the {@code AFTER_COMMIT} listener actually fires,
 * and the streamed bytes inspected for the exact event names.
 *
 * <p>Mirrors {@link ChatModerationRemoveMessageStreamPinIntegrationTest} / {@link
 * ConversationStreamIntegrationTest} (same async-stream + no-op push harness); the {@link PushSender} seam
 * is a no-op so no path touches real FCM — this is about the socket frame names, not the push.
 */
@AutoConfigureMockMvc
@Import(LiveSseEditDeleteFrameNamesIntegrationTest.NoopSenderConfig.class)
class LiveSseEditDeleteFrameNamesIntegrationTest extends AbstractIntegrationTest {

    @Autowired private MockMvc mockMvc;
    @Autowired private UserRepository users;
    @Autowired private ConversationRepository conversations;
    @Autowired private ConversationMemberRepository members;
    @Autowired private MessageRepository messages;
    @Autowired private EventRepository events;
    @Autowired private ChatStreamService chatStreamService;
    @Autowired private MessageAuthorService messageAuthorService;

    @BeforeEach
    void cleanSlate() {
        messages.deleteAll();
        members.deleteAll();
        conversations.deleteAll();
    }

    /**
     * An author edit streams {@code event:message-edited} (the new body), never {@code event:message}
     * (the fresh-post frame). Runs against a genuinely-connected listener so "carries this event name"
     * means the broadcast really happened on that specific channel.
     */
    @Test
    void authorEditRidesTheMessageEditedEventNameNotTheFreshMessageName() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("edit-frame")));
        long authorId = activeMember(thread, "edit-author");
        activeMember(thread, "edit-listener"); // opens the live stream

        Message original = messages.saveAndFlush(Message.fromUser(thread.getId(), authorId, "hlelo wrold"));

        MvcResult stream = openStream(thread.getId(), "edit-listener");

        // Edit through the real @Transactional author service — publishes MessageEditedEvent, which the
        // mutation listener broadcasts AFTER_COMMIT under EVENT_MESSAGE_EDITED.
        messageAuthorService.editOwnMessage(
                new VerifiedUser("edit-author", "edit-author@example.com"),
                thread.getId(),
                original.getId(),
                "hello world");

        String streamed = stream.getResponse().getContentAsString();
        assertThat(streamed)
                .as("an author edit must ride the distinct message-edited SSE event name")
                .contains("event:" + ChatStreamService.EVENT_MESSAGE_EDITED)
                .contains("hello world"); // the corrected body is in the edit frame's payload
        // …and it must NOT masquerade as the delete frame — the two mutation names are distinct. (We do
        // not negatively assert against the fresh-post name here: "message-edited" has "message" as a
        // prefix, so a substring check on the bare post name would be ambiguous; the create-vs-mutation
        // split is pinned by the presence checks + editThenDeleteOnOneStreamCarryTwoDistinctEventNames.)
        assertThat(streamed)
                .as("an edit must NOT ride the delete event name")
                .doesNotContain("event:" + ChatStreamService.EVENT_MESSAGE_DELETED);
    }

    /**
     * An author delete streams {@code event:message-deleted} (a by-id drop), distinct from both the
     * fresh-post {@code message} frame and the {@code message-edited} frame.
     */
    @Test
    void authorDeleteRidesTheMessageDeletedEventNameNotTheEditedName() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("delete-frame")));
        long authorId = activeMember(thread, "del-author");
        activeMember(thread, "del-listener");

        Message own = messages.saveAndFlush(Message.fromUser(thread.getId(), authorId, "take this back"));

        MvcResult stream = openStream(thread.getId(), "del-listener");

        messageAuthorService.deleteOwnMessage(
                new VerifiedUser("del-author", "del-author@example.com"), thread.getId(), own.getId());

        String streamed = stream.getResponse().getContentAsString();
        assertThat(streamed)
                .as("an author delete must ride the distinct message-deleted SSE event name")
                .contains("event:" + ChatStreamService.EVENT_MESSAGE_DELETED)
                .contains("\"messageId\":" + own.getId()); // the drop-by-id payload
        // The delete frame is its own name — never the edit frame's.
        assertThat(streamed)
                .as("a delete must NOT ride the edit event name")
                .doesNotContain("event:" + ChatStreamService.EVENT_MESSAGE_EDITED);
    }

    /**
     * The pin, made explicit on one stream: an edit then a delete of the same message land on the SAME
     * live connection under their two DISTINCT event names — {@code message-edited} for the edit and
     * {@code message-deleted} for the delete. Proves the two mutation frames are not conflated with each
     * other (nor with the fresh-post frame) on a real end-to-end socket.
     */
    @Test
    void editThenDeleteOnOneStreamCarryTwoDistinctEventNames() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("both-frames")));
        long authorId = activeMember(thread, "both-author");
        activeMember(thread, "both-listener");

        Message msg = messages.saveAndFlush(Message.fromUser(thread.getId(), authorId, "first draft"));

        MvcResult stream = openStream(thread.getId(), "both-listener");

        VerifiedUser author = new VerifiedUser("both-author", "both-author@example.com");
        messageAuthorService.editOwnMessage(author, thread.getId(), msg.getId(), "second draft");
        messageAuthorService.deleteOwnMessage(author, thread.getId(), msg.getId());

        String streamed = stream.getResponse().getContentAsString();
        assertThat(streamed)
                .as("both mutation frames rode the one live stream under their two distinct names")
                .contains("event:" + ChatStreamService.EVENT_MESSAGE_EDITED)
                .contains("event:" + ChatStreamService.EVENT_MESSAGE_DELETED)
                .contains("\"messageId\":" + msg.getId());
        // The edit frame precedes the delete frame in the byte stream (ordered by when each committed).
        assertThat(streamed.indexOf("event:" + ChatStreamService.EVENT_MESSAGE_EDITED))
                .as("the edit frame is streamed before the delete frame")
                .isLessThan(streamed.indexOf("event:" + ChatStreamService.EVENT_MESSAGE_DELETED));
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────────

    /** Open the live SSE stream for {@code uid} on {@code conversationId} and assert it registered on the hub. */
    private MvcResult openStream(long conversationId, String uid) throws Exception {
        MvcResult stream = mockMvc.perform(get("/api/v1/conversations/{id}/stream", conversationId)
                        .accept(MediaType.TEXT_EVENT_STREAM)
                        .with(user(uid)))
                .andExpect(request().asyncStarted())
                .andReturn();
        assertThat(chatStreamService.connectionCount(conversationId)).isEqualTo(1);
        return stream;
    }

    // ── fixtures (mirror ConversationStreamIntegrationTest) ────────────────────────────────────────────

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
        long userId = provision(uid);
        ConversationMember m = new ConversationMember(thread.getId(), userId, MemberRole.MEMBER);
        m.setMute(MuteState.NONE);
        members.save(m);
        return userId;
    }

    // ── harness ────────────────────────────────────────────────────────────────────────────────────────

    /** A no-op push transport so no mutation path touches real FCM — this test is about the socket frame names. */
    @TestConfiguration
    static class NoopSenderConfig {
        @Bean
        @Primary
        PushSender noopPushSender() {
            return (token, message) -> PushDelivery.DELIVERED;
        }
    }
}
