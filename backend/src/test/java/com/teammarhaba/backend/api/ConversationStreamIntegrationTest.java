package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.chat.ChatStreamService;
import com.teammarhaba.backend.chat.Conversation;
import com.teammarhaba.backend.chat.ConversationMember;
import com.teammarhaba.backend.chat.ConversationMemberRepository;
import com.teammarhaba.backend.chat.ConversationRepository;
import com.teammarhaba.backend.chat.MemberRole;
import com.teammarhaba.backend.chat.MessagePostService;
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
 * The live-chat SSE endpoint {@code GET /api/v1/conversations/{id}/stream} (TM-464) end-to-end through
 * the real security chain + Postgres. Covers the AC's two required tests:
 *
 * <ul>
 *   <li><b>Connection smoke test (auth on connect + members-only):</b> an active member's connect goes
 *       async (the stream opens and is registered on the hub); an unauthenticated caller is
 *       {@code 401}; a non-member, a kicked ({@code REMOVED}) member, and an unknown thread are all a
 *       uniform {@code 403} — a stream can't be opened on a thread you're not in, and ids can't be
 *       probed.</li>
 *   <li><b>Broadcast test:</b> with a member connected, a second member posting through the real
 *       {@link MessagePostService} write path streams the new message down the first member's live
 *       connection — proving the C2-post seam broadcasts over the transport, not just persists + pushes.</li>
 * </ul>
 *
 * <p>The {@link PushSender} seam is swapped for a no-op recorder so the post's FCM fan-out never
 * touches real Firebase; this test is only about the live socket, not the offline push.
 */
@AutoConfigureMockMvc
@Import(ConversationStreamIntegrationTest.NoopSenderConfig.class)
class ConversationStreamIntegrationTest extends AbstractIntegrationTest {

    @Autowired private MockMvc mockMvc;
    @Autowired private UserRepository users;
    @Autowired private ConversationRepository conversations;
    @Autowired private ConversationMemberRepository members;
    @Autowired private MessageRepository messages;
    @Autowired private EventRepository events;
    @Autowired private MessagePostService messagePostService;
    @Autowired private ChatStreamService chatStreamService;

    @BeforeEach
    void cleanSlate() {
        messages.deleteAll();
        members.deleteAll();
        conversations.deleteAll();
    }

    // ── connection smoke test ──────────────────────────────────────────────────────────────────────

    @Test
    void activeMemberConnectsAndTheStreamIsRegistered() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("stream-ok")));
        activeMember(thread, "s-member");

        mockMvc.perform(get("/api/v1/conversations/{id}/stream", thread.getId())
                        .accept(MediaType.TEXT_EVENT_STREAM) // the Accept a real EventSource / fetch SSE client sends
                        .with(user("s-member")))
                .andExpect(request().asyncStarted()); // the SSE stream opened (went async) rather than erroring

        // The hub is holding exactly one open stream for this thread — the connect registered it.
        assertThat(chatStreamService.connectionCount(thread.getId())).isEqualTo(1);
    }

    @Test
    void unauthenticatedConnectIsUnauthorized() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("stream-anon")));
        activeMember(thread, "anon-member");

        // No principal → the default-deny chain answers 401 before the handler runs; no stream opens.
        mockMvc.perform(get("/api/v1/conversations/{id}/stream", thread.getId()).accept(MediaType.TEXT_EVENT_STREAM))
                .andExpect(status().isUnauthorized());
        assertThat(chatStreamService.connectionCount(thread.getId())).isZero();
    }

    @Test
    void nonMemberConnectIsForbiddenAndNoStreamOpens() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("stream-nonmember")));
        activeMember(thread, "nm-member"); // a member exists, but the caller is not one
        provision("nm-outsider");

        mockMvc.perform(get("/api/v1/conversations/{id}/stream", thread.getId())
                        .accept(MediaType.TEXT_EVENT_STREAM)
                        .with(user("nm-outsider")))
                .andExpect(status().isForbidden());
        assertThat(chatStreamService.connectionCount(thread.getId())).isZero();
    }

    @Test
    void removedMemberConnectIsForbidden() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("stream-removed")));
        member(thread, "rm-member", MuteState.REMOVED); // kicked from the thread

        mockMvc.perform(get("/api/v1/conversations/{id}/stream", thread.getId())
                        .accept(MediaType.TEXT_EVENT_STREAM)
                        .with(user("rm-member")))
                .andExpect(status().isForbidden());
        assertThat(chatStreamService.connectionCount(thread.getId())).isZero();
    }

    @Test
    void unknownThreadConnectIsForbiddenAndDoesNotLeakExistence() throws Exception {
        provision("u-caller");
        mockMvc.perform(get("/api/v1/conversations/{id}/stream", 9_999_999L)
                        .accept(MediaType.TEXT_EVENT_STREAM)
                        .with(user("u-caller")))
                .andExpect(status().isForbidden()); // 403 (not 404) so a foreign/absent id can't be probed
    }

    // ── broadcast test ─────────────────────────────────────────────────────────────────────────────

    @Test
    void aPostedMessageIsStreamedLiveToAConnectedMember() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("stream-broadcast")));
        activeMember(thread, "listener"); // connects to the live stream
        activeMember(thread, "poster"); // posts a message through the real write path

        // Listener opens the SSE stream (async) and it registers on the hub.
        MvcResult stream = mockMvc.perform(get("/api/v1/conversations/{id}/stream", thread.getId())
                        .accept(MediaType.TEXT_EVENT_STREAM)
                        .with(user("listener")))
                .andExpect(request().asyncStarted())
                .andReturn();
        assertThat(chatStreamService.connectionCount(thread.getId())).isEqualTo(1);

        // Poster posts through the real service — persist + audit + push + LIVE broadcast (the C2 seam).
        messagePostService.post(new VerifiedUser("poster", "poster@example.com"), thread.getId(), "live hello everyone");

        // The new message was streamed down the listener's open connection as an SSE `message` event.
        String streamed = stream.getResponse().getContentAsString();
        assertThat(streamed).contains("event:" + ChatStreamService.EVENT_MESSAGE);
        assertThat(streamed).contains("live hello everyone");
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

    private long activeMember(Conversation thread, String uid) {
        return member(thread, uid, MuteState.NONE);
    }

    private long member(Conversation thread, String uid, MuteState mute) {
        long userId = provision(uid);
        ConversationMember m = new ConversationMember(thread.getId(), userId, MemberRole.MEMBER);
        m.setMute(mute);
        members.save(m);
        return userId;
    }

    // ── harness ──────────────────────────────────────────────────────────────────────────────────

    /** A no-op push transport so the post's FCM fan-out never reaches real Firebase — this test is about the socket. */
    @TestConfiguration
    static class NoopSenderConfig {
        @Bean
        @Primary
        PushSender noopPushSender() {
            return (token, message) -> PushDelivery.DELIVERED;
        }
    }
}
