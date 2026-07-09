package com.teammarhaba.backend.chat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.notify.PushDelivery;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushSender;
import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.user.UserService;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Proves the TM-579 fix at the seam that had the bug: {@link MessagePostService#post} must fan the
 * new-message push out <em>after</em> its write transaction commits, never in-line. Both acceptance
 * criteria are exercised against a real Postgres, driven all the way through the post-commit listener
 * ({@link MessageCreatedPushListener}) and the TM-397 delivery rails, with only the outermost
 * {@link PushSender} swapped for a recording fake:
 *
 * <ul>
 *   <li><b>Push fires after commit</b> — a successful post reaches the thread's other active member's
 *       device (the listener ran on commit, so the fan-out happened);</li>
 *   <li><b>No phantom push on rollback</b> — a post whose surrounding transaction rolls back leaves no
 *       message row <em>and</em> sends no push (the {@code AFTER_COMMIT} listener never ran).</li>
 * </ul>
 *
 * <p>The same post-commit gate is proven for the <b>live SSE broadcast</b> (TM-464): its listener
 * ({@link MessageCreatedStreamListener}) also rides the {@link MessageCreatedEvent}, so a committed post
 * broadcasts and a rolled-back one does not. We spy the {@link ChatStreamService} bean (no stream is
 * connected in this fixture, so the real {@code broadcast} is a harmless no-op returning 0) and assert
 * the interaction, giving push and live-broadcast the same commit/rollback symmetry from one harness.
 *
 * <p>The fixture uses an admin-broadcast conversation (no event id) so {@code requireOpenThread} falls
 * back to the plain soft-close flag — a fresh broadcast thread is open — keeping the test focused on the
 * transaction/push ordering rather than the event close-policy (which its own tests cover).
 */
@Import(MessagePostServicePushTest.RecordingSenderConfig.class)
class MessagePostServicePushTest extends AbstractIntegrationTest {

    @Autowired private MessagePostService postService;
    @Autowired private UserService userService;
    @Autowired private UserRepository users;
    @Autowired private ConversationRepository conversations;
    @Autowired private ConversationMemberRepository members;
    @Autowired private MessageRepository messages;
    @Autowired private DeviceTokenRepository deviceTokens;
    @Autowired private PlatformTransactionManager txManager;
    @Autowired private RecordingPushSender sender;

    // Spy the live-SSE hub so we can assert the broadcast fires after commit / never on rollback, exactly
    // like the push. No stream is connected in this fixture, so the real broadcast is a no-op returning 0.
    @MockitoSpyBean private ChatStreamService chatStream;

    /** The verified caller who posts — provisioned as an active member of the thread below. */
    private final VerifiedUser author = new VerifiedUser("post-author", "post-author@example.com");

    private Long threadId;

    @BeforeEach
    void cleanSlate() {
        // Child → parent so FK order is safe; every fixture below is committed (not in a test tx), so the
        // AFTER_COMMIT listener fires for real and a rolled-back post only rolls back its own rows.
        messages.deleteAll();
        members.deleteAll();
        conversations.deleteAll();
        deviceTokens.deleteAll();
        sender.reset();

        // A broadcast thread (event id null) is open by default — the post gate only needs an active member.
        Conversation thread = conversations.save(Conversation.adminBroadcast());
        threadId = thread.getId();

        // The author is an active member (so the post gate passes). Provision via the same path post() uses,
        // so the member row keys on the id post() will resolve.
        long authorId = userService.provision(author).getId();
        activeMember(threadId, authorId);

        // One other active member with a push-eligible device — the fan-out's target. Its token is what the
        // recording sender should (or should not) receive.
        long recipientId = newUser("post-recipient", NotificationPref.BOTH);
        activeMember(threadId, recipientId);
        deviceTokens.saveAndFlush(new DeviceToken(recipientId, "tok-recipient", DevicePlatform.ANDROID, Instant.now()));
    }

    @Test
    void pushFiresAfterCommit() {
        // A plain, successful post: its own @Transactional commits, so the AFTER_COMMIT listener runs the
        // fan-out before post() returns — the recipient's device has the push.
        postService.post(author, threadId, "hello team", null); // null = plain, non-reply message (TM-466)

        assertThat(deliveredTokens()).containsExactly("tok-recipient");
        PushMessage pushed = sender.deliveries().get(0).message();
        assertThat(pushed.title()).isEqualTo("New message");
        assertThat(pushed.body()).isEqualTo("hello team");
        // The message itself was persisted.
        assertThat(messages.findAll()).hasSize(1);
        // ...and the live SSE broadcast fired on the same post-commit event (TM-464), symmetric with the push.
        verify(chatStream).broadcast(eq(threadId), eq(ChatStreamService.EVENT_MESSAGE), any());
    }

    @Test
    void noPushWhenTransactionRollsBack() {
        // Run the post inside an OUTER transaction that then blows up: post()'s @Transactional joins it
        // (REQUIRED), so the whole thing rolls back and the AFTER_COMMIT push listener — bound to that
        // outer boundary — never fires. This is the phantom-push scenario the ticket fixes.
        TransactionTemplate tx = new TransactionTemplate(txManager);
        assertThatThrownBy(() -> tx.executeWithoutResult(status -> {
                    postService.post(author, threadId, "will roll back", null); // null = non-reply (TM-466)
                    // A failure AFTER the message row + event were written, before commit.
                    throw new IllegalStateException("boom after post, before commit");
                }))
                .isInstanceOf(IllegalStateException.class);

        // No push was sent (the commit never happened)...
        assertThat(sender.deliveries()).isEmpty();
        // ...no live SSE broadcast fired either — the AFTER_COMMIT stream listener is bound to the same
        // rolled-back boundary, so a connected member is never told over the socket about a phantom message.
        verify(chatStream, never()).broadcast(anyLong(), any(), any());
        // ...and the message row rolled back with the transaction, so there is nothing to have pushed about.
        assertThat(messages.findAll()).isEmpty();
    }

    // ── fixtures ─────────────────────────────────────────────────────────────────────────────────

    private long newUser(String uid, NotificationPref pref) {
        User user = users.findByFirebaseUid(uid)
                .orElseGet(() -> users.saveAndFlush(new User(uid, uid + "@example.com", uid)));
        user.setNotificationPref(pref);
        return users.saveAndFlush(user).getId();
    }

    private void activeMember(Long conversationId, long userId) {
        ConversationMember m = new ConversationMember(conversationId, userId, MemberRole.MEMBER);
        m.setMute(MuteState.NONE);
        members.save(m);
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
