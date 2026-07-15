package com.teammarhaba.backend.chat;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.notify.Notification;
import com.teammarhaba.backend.notify.NotificationRepository;
import com.teammarhaba.backend.notify.NotificationType;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Proves the @mention → durable-notification fan-out (TM-469) against a real Postgres, exercising the
 * AC's "notification fired", "@everyone/@here expansion", "non-member ignored" and "muted-member
 * handling" branches end-to-end through {@link MentionNotifier} + the reused {@link NotificationWriter}
 * store. Drives the notifier directly on a persisted message (rather than through the whole post path)
 * so each recipient rule is asserted in isolation.
 */
class MentionNotifierTest extends AbstractIntegrationTest {

    @Autowired private MentionNotifier notifier;
    @Autowired private UserRepository users;
    @Autowired private ConversationRepository conversations;
    @Autowired private ConversationMemberRepository members;
    @Autowired private MessageRepository messages;
    @Autowired private NotificationRepository notifications;
    @Autowired private ChatStreamService streams;

    private Long threadId;
    private long authorId;
    private long aliceId;
    private long bobId;
    private long eveId; // an active member who has self-muted this thread (TM-471)
    private long daveId; // a real account that is NOT a member of the thread
    private long roscoeId; // a READ_ONLY member — outside the active (MuteState.NONE) roster entirely

    @BeforeEach
    void seed() {
        notifications.deleteAll();
        messages.deleteAll();
        members.deleteAll();
        conversations.deleteAll();

        threadId = conversations.save(Conversation.adminBroadcast()).getId();

        authorId = user("author");
        aliceId = user("Alice");
        bobId = user("Bob");
        eveId = user("Eve");
        daveId = user("Dave");
        roscoeId = user("Roscoe");

        activeMember(authorId);
        activeMember(aliceId);
        activeMember(bobId);
        selfMutedMember(eveId);
        readOnlyMember(roscoeId);
        // Dave is intentionally NOT added as a member — a mention of him must resolve to nobody.
    }

    @Test
    void individualMentionNotifiesOnlyThatMember() {
        notifier.notifyMentions(post("morning @Alice, are you coming?"));

        assertThat(hasMention(aliceId)).isTrue();
        assertThat(hasMention(bobId)).isFalse();
        assertThat(hasMention(authorId)).isFalse();
    }

    @Test
    void theMentionRowNamesTheSenderAndCarriesThePreview() {
        Notification row = onlyMention(aliceId, post("morning @Alice"));
        assertThat(row.getType()).isEqualTo(NotificationType.CHAT_MENTION);
        assertThat(row.getTitle()).isEqualTo("author mentioned you");
        assertThat(row.getBody()).isEqualTo("morning @Alice");
    }

    @Test
    void nonMemberMentionNotifiesNobody() {
        int written = notifier.notifyMentions(post("hey @Dave welcome"));

        assertThat(written).isZero();
        assertThat(hasMention(daveId)).isFalse();
        assertThat(hasMention(aliceId)).isFalse();
    }

    @Test
    void everyoneExpandsToAllActiveMembersExceptSender() {
        notifier.notifyMentions(post("listen up @everyone"));

        assertThat(hasMention(aliceId)).isTrue();
        assertThat(hasMention(bobId)).isTrue();
        assertThat(hasMention(authorId)).isFalse(); // never notify yourself
    }

    @Test
    void selfMutedMemberIsNotNotifiedByEveryone() {
        notifier.notifyMentions(post("@everyone please read"));

        assertThat(hasMention(aliceId)).isTrue(); // a normal active member gets it
        assertThat(hasMention(eveId)).isFalse(); // ...but the self-muted member is respected (TM-471)
    }

    @Test
    void readOnlyMemberIsExcludedFromEveryoneExpansion() {
        // A READ_ONLY member (organiser-restricted / admin-muted) is not part of the active roster the
        // notifier builds from (findByConversationIdAndMute(..., MuteState.NONE)), so @everyone — which
        // expands only over that active set — never reaches them. This is a DISTINCT exclusion from Eve's
        // self-mute (she stays MuteState.NONE and is dropped by the receivesPush() filter instead).
        notifier.notifyMentions(post("heads up @everyone"));

        assertThat(hasMention(aliceId)).isTrue(); // a genuinely active member is notified
        assertThat(hasMention(roscoeId)).isFalse(); // ...but the READ_ONLY member is outside the roster
    }

    @Test
    void explicitMentionOfAReadOnlyMemberNotifiesNobody() {
        // Even an individual @Name that resolves to a real account with a live membership row does NOT
        // notify a READ_ONLY member: their name is never on the mentionable roster (only MuteState.NONE
        // members are), so the resolver finds no match — mirroring the non-member ("@Dave") case, but for
        // a member whose row exists yet is muted/read-only.
        int written = notifier.notifyMentions(post("could you check this @Roscoe?"));

        assertThat(written).isZero();
        assertThat(hasMention(roscoeId)).isFalse();
        assertThat(hasMention(aliceId)).isFalse();
    }

    @Test
    void hereExpandsToOnlineMembersOnly() {
        // Register a live stream owned by Alice's uid so presence reports her online; Bob stays offline.
        streams.register(threadId, new SseEmitter(), "Alice");

        notifier.notifyMentions(post("who's around @here"));

        assertThat(hasMention(aliceId)).isTrue(); // online → notified
        assertThat(hasMention(bobId)).isFalse(); // active but offline → not part of @here
    }

    @Test
    void reDeliveryOfTheSameMessageIsIdempotent() {
        Message message = post("@Alice hi");
        notifier.notifyMentions(message);
        notifier.notifyMentions(message); // an at-least-once redelivery of the post-commit event

        assertThat(mentionsFor(aliceId)).hasSize(1); // one row per (user, message), not two
    }

    // ── fixtures ─────────────────────────────────────────────────────────────────────────────────

    private long user(String uid) {
        return users.findByFirebaseUid(uid)
                .orElseGet(() -> users.saveAndFlush(new User(uid, uid + "@example.com", uid)))
                .getId();
    }

    private void activeMember(long userId) {
        members.save(new ConversationMember(threadId, userId, MemberRole.MEMBER));
    }

    private void selfMutedMember(long userId) {
        ConversationMember m = new ConversationMember(threadId, userId, MemberRole.MEMBER);
        m.muteNotifications(); // active member, but has silenced this thread (TM-471)
        members.save(m);
    }

    private void readOnlyMember(long userId) {
        ConversationMember m = new ConversationMember(threadId, userId, MemberRole.MEMBER);
        m.setMute(MuteState.READ_ONLY); // may read but not post; outside the active roster and push (TM-435)
        members.save(m);
    }

    private Message post(String body) {
        return messages.saveAndFlush(Message.fromUser(threadId, authorId, body));
    }

    private List<Notification> mentionsFor(long userId) {
        return notifications.findByUserIdOrderByCreatedAtDescIdDesc(userId).stream()
                .filter(n -> n.getType() == NotificationType.CHAT_MENTION)
                .toList();
    }

    private boolean hasMention(long userId) {
        return !mentionsFor(userId).isEmpty();
    }

    private Notification onlyMention(long userId, Message message) {
        notifier.notifyMentions(message);
        List<Notification> rows = mentionsFor(userId);
        assertThat(rows).hasSize(1);
        return rows.get(0);
    }
}
