package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
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
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The typing-indicator signal endpoint {@code POST /api/v1/conversations/{id}/typing} (TM-465)
 * end-to-end through the real security chain + Postgres. Covers the AC's two required behaviours:
 *
 * <ul>
 *   <li><b>Member-gated:</b> an unauthenticated caller is {@code 401}; a non-member, a kicked
 *       ({@code REMOVED}) member, and an unknown thread are all a uniform {@code 403} — a typing signal
 *       can't be sent to a thread you're not in, and ids can't be probed. An active member is accepted
 *       ({@code 202}).</li>
 *   <li><b>Broadcasts to OTHERS, not the sender:</b> with two members connected to the same thread's live
 *       stream, one member signalling typing streams a {@code typing} event (carrying their name) down the
 *       OTHER member's connection — but NOT down the typist's own stream (a client must never render "you
 *       are typing"). Ephemeral: nothing is persisted.</li>
 * </ul>
 */
@AutoConfigureMockMvc
class ConversationTypingIntegrationTest extends AbstractIntegrationTest {

    @Autowired private MockMvc mockMvc;
    @Autowired private UserRepository users;
    @Autowired private ConversationRepository conversations;
    @Autowired private ConversationMemberRepository members;
    @Autowired private MessageRepository messages;
    @Autowired private EventRepository events;
    @Autowired private ChatStreamService chatStreamService;

    @BeforeEach
    void cleanSlate() {
        messages.deleteAll();
        members.deleteAll();
        conversations.deleteAll();
    }

    // ── member gate ──────────────────────────────────────────────────────────────────────────────────

    @Test
    void activeMemberSignallingTypingIsAccepted() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("typing-ok")));
        activeMember(thread, "t-member");

        mockMvc.perform(post("/api/v1/conversations/{id}/typing", thread.getId()).with(user("t-member")))
                .andExpect(status().isAccepted()); // 202, no body — the signal was accepted for fan-out
    }

    @Test
    void unauthenticatedSignalIsUnauthorized() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("typing-anon")));
        activeMember(thread, "anon-typist");

        // No principal → the default-deny chain answers 401 before the handler runs.
        mockMvc.perform(post("/api/v1/conversations/{id}/typing", thread.getId()))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void nonMemberSignalIsForbidden() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("typing-nonmember")));
        activeMember(thread, "nm-member"); // a member exists, but the caller is not one
        provision("nm-outsider");

        mockMvc.perform(post("/api/v1/conversations/{id}/typing", thread.getId()).with(user("nm-outsider")))
                .andExpect(status().isForbidden());
    }

    @Test
    void removedMemberSignalIsForbidden() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("typing-removed")));
        member(thread, "rm-typist", MuteState.REMOVED); // kicked from the thread

        mockMvc.perform(post("/api/v1/conversations/{id}/typing", thread.getId()).with(user("rm-typist")))
                .andExpect(status().isForbidden());
    }

    @Test
    void unknownThreadSignalIsForbiddenAndDoesNotLeakExistence() throws Exception {
        provision("u-typist");
        mockMvc.perform(post("/api/v1/conversations/{id}/typing", 9_999_999L).with(user("u-typist")))
                .andExpect(status().isForbidden()); // 403 (not 404) so a foreign/absent id can't be probed
    }

    // ── broadcast: to others, not the sender ─────────────────────────────────────────────────────────

    @Test
    void typingIsStreamedToOtherMembersButNotBackToTheTypist() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("typing-broadcast")));
        activeMember(thread, "listener"); // the OTHER member — should receive the typing event
        activeMember(thread, "typist"); // signals typing — must NOT receive their own event

        // Both members open live SSE streams (async), each registered under its owner's uid.
        MvcResult listenerStream = openStream(thread.getId(), "listener");
        MvcResult typistStream = openStream(thread.getId(), "typist");
        assertThat(chatStreamService.connectionCount(thread.getId())).isEqualTo(2);

        // The typist signals typing (body-less heartbeat → typing:true).
        mockMvc.perform(post("/api/v1/conversations/{id}/typing", thread.getId()).with(user("typist")))
                .andExpect(status().isAccepted());

        // The listener's live connection received the typing event carrying the typist's name...
        String listened = listenerStream.getResponse().getContentAsString();
        assertThat(listened).contains("event:" + ChatStreamService.EVENT_TYPING);
        assertThat(listened).contains("typist"); // the typist's display name in the payload

        // ...but the typist's OWN stream never got it — a client must not render "you are typing".
        String echoed = typistStream.getResponse().getContentAsString();
        assertThat(echoed).doesNotContain("event:" + ChatStreamService.EVENT_TYPING);
    }

    @Test
    void anExplicitStopSignalIsBroadcastAsTypingFalse() throws Exception {
        Conversation thread = conversations.save(Conversation.forEvent(openEvent("typing-stop")));
        activeMember(thread, "stop-listener");
        activeMember(thread, "stop-typist");

        MvcResult listenerStream = openStream(thread.getId(), "stop-listener");

        // {"typing": false} → an explicit "stopped" so the receiver can clear the indicator at once.
        mockMvc.perform(post("/api/v1/conversations/{id}/typing", thread.getId())
                        .with(user("stop-typist"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"typing\":false}"))
                .andExpect(status().isAccepted());

        String listened = listenerStream.getResponse().getContentAsString();
        assertThat(listened).contains("event:" + ChatStreamService.EVENT_TYPING);
        assertThat(listened).contains("\"typing\":false");
    }

    // ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

    /** Open a live SSE stream for {@code uid} (async) and assert it started; returns the async result. */
    private MvcResult openStream(long conversationId, String uid) throws Exception {
        return mockMvc.perform(get("/api/v1/conversations/{id}/stream", conversationId)
                        .accept(MediaType.TEXT_EVENT_STREAM)
                        .with(user(uid)))
                .andExpect(request().asyncStarted())
                .andReturn();
    }

    /** An authenticated USER principal for {@code uid} — the endpoint resolves the acting member from it. */
    private static RequestPostProcessor user(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of(new SimpleGrantedAuthority("ROLE_USER"))));
    }

    /** Provision (or fetch) a real account for {@code uid} (displayName = uid), returning its id. */
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
}
