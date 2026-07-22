package com.teammarhaba.backend.api;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

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
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * TM-957 (from the TM-942 closure review of the TM-461 reactions endpoint): the un-react
 * {@code DELETE /messages/{messageId}/reactions?emoji=…} query param must be length-bounded exactly like
 * the react body's {@code emoji} field ({@code @Size(max = 32)} on {@link ReactionRequest}). Before this
 * fix the un-react param was unbounded, so an over-length emoji reached the service instead of being a
 * clean {@code 400} at the web edge. Spring Boot 3.5 enforces method-parameter constraints on the
 * controller automatically (no {@code @Validated} needed), so the {@code @Size} on the param is honoured.
 *
 * <p>Runs end to end through the real security chain + Postgres against a live, reactable message (the
 * caller is an active member of an open thread), so the request genuinely reaches the controller method —
 * only the bad-length param is rejected before the body runs.
 */
@AutoConfigureMockMvc
class MessageReactionEmojiSizeIntegrationTest extends AbstractIntegrationTest {

    /** 33 chars — one over the @Size(max = 32) cap. */
    private static final String OVER_LIMIT = "x".repeat(33);
    /** Exactly 32 chars — the accepted boundary. */
    private static final String AT_LIMIT = "x".repeat(32);

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ConversationRepository conversations;

    @Autowired
    private ConversationMemberRepository members;

    @Autowired
    private MessageRepository messages;

    @Autowired
    private UserRepository users;

    @Test
    void unreactWithAnOverLengthEmojiParamIs400() throws Exception {
        String uid = "react-size-unreact-" + UUID.randomUUID();
        Long messageId = reactableMessage(uid);

        // FAIL-BEFORE: an unbounded param let this through to the service (a 200 no-op). With the @Size
        // guard it is a clean Bean-Validation 400 at the web edge.
        mockMvc.perform(delete("/api/v1/messages/" + messageId + "/reactions")
                        .param("emoji", OVER_LIMIT)
                        .with(caller(uid)))
                .andExpect(status().isBadRequest());
    }

    @Test
    void unreactWithAnAtLimitEmojiParamIsAccepted() throws Exception {
        String uid = "react-size-unreact-ok-" + UUID.randomUUID();
        Long messageId = reactableMessage(uid);

        // The 32-char boundary is within the cap — accepted (an idempotent un-react no-op → 200).
        mockMvc.perform(delete("/api/v1/messages/" + messageId + "/reactions")
                        .param("emoji", AT_LIMIT)
                        .with(caller(uid)))
                .andExpect(status().isOk());
    }

    @Test
    void reactWithAnOverLengthEmojiBodyIs400() throws Exception {
        // The mirror the un-react path must match: the react body's emoji is already @Size(max = 32).
        String uid = "react-size-react-" + UUID.randomUUID();
        Long messageId = reactableMessage(uid);

        mockMvc.perform(post("/api/v1/messages/" + messageId + "/reactions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"emoji\":\"" + OVER_LIMIT + "\"}")
                        .with(caller(uid)))
                .andExpect(status().isBadRequest());
    }

    // ------------------------------------------------------------------ fixtures

    /** A live, reactable message in an open broadcast thread the caller is an active member of. */
    private Long reactableMessage(String uid) {
        Long userId = users.save(new User(uid, uid + "@example.com", uid)).getId();
        Long thread = conversations.save(Conversation.adminBroadcast()).getId();
        ConversationMember member = new ConversationMember(thread, userId, MemberRole.MEMBER);
        member.setMute(MuteState.NONE);
        members.save(member);
        return messages.save(Message.fromSystem(thread, "react to me", null)).getId();
    }

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }
}
