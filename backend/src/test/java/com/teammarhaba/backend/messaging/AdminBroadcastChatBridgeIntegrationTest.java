package com.teammarhaba.backend.messaging;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.chat.Conversation;
import com.teammarhaba.backend.chat.ConversationMember;
import com.teammarhaba.backend.chat.ConversationMemberRepository;
import com.teammarhaba.backend.chat.ConversationRepository;
import com.teammarhaba.backend.chat.ConversationType;
import com.teammarhaba.backend.chat.MemberRole;
import com.teammarhaba.backend.chat.Message;
import com.teammarhaba.backend.chat.MessageRepository;
import com.teammarhaba.backend.chat.MuteState;
import com.teammarhaba.backend.notify.NotificationRepository;
import com.teammarhaba.backend.notify.NotificationType;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * TM-588 — the admin-send → chat bridge. An admin broadcast (the TM-441 {@link AdminMessageService#send}
 * path) must ALSO be persisted as a re-readable system {@link Message} in each recipient's personal
 * {@code ADMIN_BROADCAST} channel (TM-445's "from TeamMarhaba" thread), while the existing
 * {@code ADMIN_MESSAGE} notification delivery stays unaffected.
 *
 * <p>Runs against a real Postgres (Testcontainers) via {@link AbstractIntegrationTest}, and is
 * deliberately NOT {@code @Transactional} so {@code send()} owns its own transaction exactly as
 * production — proving the chat rows are genuinely committed (not just visible inside a test-managed
 * transaction), the same convention as {@link AdminMessageSendAtomicityIntegrationTest}.
 */
class AdminBroadcastChatBridgeIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private AdminMessageService adminMessageService;

    @Autowired
    private UserRepository users;

    @Autowired
    private ConversationRepository conversations;

    @Autowired
    private ConversationMemberRepository members;

    @Autowired
    private MessageRepository messages;

    @Autowired
    private NotificationRepository notifications;

    @Test
    void broadcastIsPersistedAsASystemMessageInTheRecipientsBroadcastThread() {
        User recipient = users.save(new User("tm588-a", "tm588-a@example.com", "TM588 Recipient A"));
        long recipientId = recipient.getId();
        long adminRowsBefore = adminNotificationCount(recipientId);

        adminMessageService.send(
                "tm588-admin",
                AudienceSpec.user(recipientId),
                TargetType.USER,
                "user:" + recipientId,
                "Scheduled maintenance",
                "The app will be briefly unavailable tonight.",
                "#/home");

        // The recipient now has a personal ADMIN_BROADCAST channel (created on this first broadcast) and
        // is an active MEMBER of it.
        Optional<Conversation> channel =
                conversations.findByTypeAndOwnerUserId(ConversationType.ADMIN_BROADCAST, recipientId);
        assertThat(channel).as("a personal broadcast channel is created for the recipient").isPresent();
        long channelId = channel.get().getId();

        ConversationMember membership = members
                .findByConversationIdAndUserId(channelId, recipientId)
                .orElseThrow();
        assertThat(membership.getRole()).isEqualTo(MemberRole.MEMBER);
        assertThat(membership.getMute()).isEqualTo(MuteState.NONE);

        // The broadcast is a re-readable system message in that channel: null sender ("from TeamMarhaba"),
        // the exact body, and the validated deep-link the TM-445 render surfaces as a tap-through CTA.
        List<Message> thread =
                messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(channelId);
        assertThat(thread).hasSize(1);
        Message line = thread.get(0);
        assertThat(line.isSystem()).as("null sender drives the 'from TeamMarhaba' render").isTrue();
        assertThat(line.getSenderId()).isNull();
        assertThat(line.getBody()).isEqualTo("The app will be briefly unavailable tonight.");
        assertThat(line.getDeepLink()).isEqualTo("#/home");

        // The existing notification delivery is UNAFFECTED — the durable ADMIN_MESSAGE bell row is still
        // written alongside the new chat copy.
        assertThat(adminNotificationCount(recipientId))
                .as("the existing ADMIN_MESSAGE inbox delivery still happens")
                .isEqualTo(adminRowsBefore + 1);
    }

    @Test
    void aSecondBroadcastReusesTheSameChannelAndAppendsAnotherLine() {
        User recipient = users.save(new User("tm588-b", "tm588-b@example.com", "TM588 Recipient B"));
        long recipientId = recipient.getId();

        adminMessageService.send(
                "tm588-admin",
                AudienceSpec.user(recipientId),
                TargetType.USER,
                "user:" + recipientId,
                "First notice",
                "One.",
                null);
        adminMessageService.send(
                "tm588-admin",
                AudienceSpec.user(recipientId),
                TargetType.USER,
                "user:" + recipientId,
                "Second notice",
                "Two.",
                null);

        // Still exactly ONE personal channel (the singleton is reused, not re-created), with ONE
        // membership row, and both broadcasts appended as system messages.
        Optional<Conversation> channel =
                conversations.findByTypeAndOwnerUserId(ConversationType.ADMIN_BROADCAST, recipientId);
        assertThat(channel).isPresent();
        long channelId = channel.get().getId();

        assertThat(members.findByConversationId(channelId))
                .as("the recipient joins their channel once, then it is reused")
                .hasSize(1);

        List<Message> thread =
                messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(channelId);
        assertThat(thread).extracting(Message::getBody).containsExactlyInAnyOrder("One.", "Two.");
        assertThat(thread).allMatch(Message::isSystem);
    }

    @Test
    void aFullLengthAdminBodyIsStoredWholeInTheChatCopy() {
        User recipient = users.save(new User("tm588-c", "tm588-c@example.com", "TM588 Recipient C"));
        long recipientId = recipient.getId();

        // The admin body cap is 5000 (AdminMessageRequest.MAX_BODY_LENGTH), wider than the chat message
        // store's original VARCHAR(4000) — V33 widens it to 5000 so the full broadcast fits as a system
        // message rather than aborting the send with a length violation. Send a maximal body and assert
        // it round-trips into the chat copy in full (no truncation).
        String maxBody = "x".repeat(5000);
        adminMessageService.send(
                "tm588-admin",
                AudienceSpec.user(recipientId),
                TargetType.USER,
                "user:" + recipientId,
                "Long notice",
                maxBody,
                null);

        long channelId = conversations
                .findByTypeAndOwnerUserId(ConversationType.ADMIN_BROADCAST, recipientId)
                .orElseThrow()
                .getId();
        List<Message> thread =
                messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(channelId);
        assertThat(thread).hasSize(1);
        assertThat(thread.get(0).getBody()).hasSize(5000).isEqualTo(maxBody);
    }

    /** Count of durable {@code ADMIN_MESSAGE} inbox rows currently persisted for the given user. */
    private long adminNotificationCount(long userId) {
        return notifications.findByUserIdOrderByCreatedAtDescIdDesc(userId).stream()
                .filter(n -> n.getType() == NotificationType.ADMIN_MESSAGE)
                .count();
    }
}
