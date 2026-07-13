package com.teammarhaba.backend.chat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.event.EventAttendeeNotifier;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * The recipient / exclusion / deep-link policy {@link NewMessageNotifier} owns (TM-437), pinned
 * against mocked collaborators — the actual pref + push-eligible-token delivery mechanics live behind
 * the {@link EventAttendeeNotifier} rails (proven end-to-end in
 * {@link NewMessageNotifierIntegrationTest} with a recording push sender). Here we assert exactly
 * <em>who</em> the hook hands to that seam and <em>what</em> message it builds:
 *
 * <ul>
 *   <li>recipients are the active ({@code mute = NONE}) members — the hook reads that set and drops
 *       {@code REMOVED}/{@code READ_ONLY} by querying {@code NONE};</li>
 *   <li>the sender is excluded (no self-push), while a system/admin message (null sender) excludes
 *       nobody;</li>
 *   <li>an empty/only-the-sender thread and a missing conversation are no-ops (the seam is never
 *       touched);</li>
 *   <li>the deep-link resolves to the thread (event page for a group chat, the message's own route
 *       when it has one) and the title is contextual.</li>
 * </ul>
 */
@ExtendWith(MockitoExtension.class)
class NewMessageNotifierTest {

    private static final long CONV_ID = 7L;
    private static final long EVENT_ID = 42L;
    private static final long SENDER = 1L;

    @Mock private ConversationRepository conversations;
    @Mock private ConversationMemberRepository members;
    @Mock private EventAttendeeNotifier attendeeNotifier;

    private NewMessageNotifier notifier() {
        return new NewMessageNotifier(conversations, members, attendeeNotifier);
    }

    /** A saved member of {@code CONV_ID} for {@code userId}, active ({@code mute = NONE}). */
    private ConversationMember activeMember(long userId) {
        return new ConversationMember(CONV_ID, userId, MemberRole.MEMBER);
    }

    private void stubConversation(Conversation conversation) {
        when(conversations.findById(CONV_ID)).thenReturn(Optional.of(conversation));
    }

    /** The active-member roster the fan-out queries ({@code mute = NONE}). */
    private void stubActiveMembers(ConversationMember... roster) {
        when(members.findByConversationIdAndMute(CONV_ID, MuteState.NONE)).thenReturn(List.of(roster));
    }

    private void stubDelivered() {
        when(attendeeNotifier.pushToUsers(anyCollection(), any(PushMessage.class)))
                .thenReturn(new PushFanout(1, 1, 0, 0));
    }

    @SuppressWarnings("unchecked")
    private List<Long> capturedRecipients() {
        ArgumentCaptor<List<Long>> recipients = ArgumentCaptor.forClass(List.class);
        verify(attendeeNotifier).pushToUsers(recipients.capture(), any(PushMessage.class));
        return recipients.getValue();
    }

    private PushMessage capturedMessage() {
        ArgumentCaptor<PushMessage> message = ArgumentCaptor.forClass(PushMessage.class);
        verify(attendeeNotifier).pushToUsers(anyCollection(), message.capture());
        return message.getValue();
    }

    // ── recipients + exclusions ──────────────────────────────────────────────────────────────────

    @Test
    void pushesToEveryActiveMemberExceptTheSender() {
        stubConversation(Conversation.forEvent(EVENT_ID));
        // The active roster the hook is handed already excludes REMOVED/READ_ONLY (it queries NONE);
        // it must additionally drop the sender.
        stubActiveMembers(activeMember(SENDER), activeMember(2L), activeMember(3L));
        stubDelivered();

        notifier().onMessageCreated(Message.fromUser(CONV_ID, SENDER, "hey all"));

        // Only the two non-sender active members are handed to the delivery seam.
        assertThat(capturedRecipients()).containsExactly(2L, 3L);
        // And the recipient set was read from the active (NONE) query — the mechanism that skips
        // REMOVED and READ_ONLY members.
        verify(members).findByConversationIdAndMute(CONV_ID, MuteState.NONE);
    }

    @Test
    void aSystemMessageExcludesNobody() {
        // A system / admin "from TeamMarhaba" message has a null sender, so every active member gets it.
        stubConversation(Conversation.adminBroadcast());
        stubActiveMembers(activeMember(2L), activeMember(3L), activeMember(4L));
        stubDelivered();

        notifier().onMessageCreated(Message.fromSystem(CONV_ID, "campaign body", "#/home"));

        assertThat(capturedRecipients()).containsExactly(2L, 3L, 4L);
    }

    @Test
    void aThreadWhereOnlyTheSenderIsActivePushesToNobody() {
        stubConversation(Conversation.forEvent(EVENT_ID));
        stubActiveMembers(activeMember(SENDER)); // the sender is the sole active member

        PushFanout result = notifier().onMessageCreated(Message.fromUser(CONV_ID, SENDER, "just me here"));

        assertThat(result).isEqualTo(new PushFanout(0, 0, 0, 0));
        verifyNoInteractions(attendeeNotifier); // the delivery seam is never touched
    }

    @Test
    void aMissingConversationIsANoOp() {
        when(conversations.findById(CONV_ID)).thenReturn(Optional.empty());

        PushFanout result = notifier().onMessageCreated(Message.fromUser(CONV_ID, SENDER, "orphan"));

        assertThat(result).isEqualTo(new PushFanout(0, 0, 0, 0));
        verify(members, never()).findByConversationIdAndMute(any(), any());
        verifyNoInteractions(attendeeNotifier);
    }

    @Test
    void aSoftDeletedMessageNeverNotifies() {
        Message removed = Message.fromUser(CONV_ID, SENDER, "removed by moderation");
        removed.softDelete(java.time.Instant.now());

        PushFanout result = notifier().onMessageCreated(removed);

        assertThat(result).isEqualTo(new PushFanout(0, 0, 0, 0));
        verifyNoInteractions(conversations); // short-circuits before even resolving the thread
        verifyNoInteractions(attendeeNotifier);
    }

    // ── message content: title + deep-link ───────────────────────────────────────────────────────

    @Test
    void eventGroupMessageDeepLinksToItsEventPageWithAMemberTitle() {
        stubConversation(Conversation.forEvent(EVENT_ID));
        stubActiveMembers(activeMember(SENDER), activeMember(2L));
        stubDelivered();

        notifier().onMessageCreated(Message.fromUser(CONV_ID, SENDER, "see you there"));

        PushMessage message = capturedMessage();
        assertThat(message.title()).isEqualTo("New message");
        assertThat(message.body()).isEqualTo("see you there");
        assertThat(message.route()).isEqualTo("#/events/" + EVENT_ID); // the thread's event page
    }

    @Test
    void aSystemMessagesOwnRouteIsPreservedWithATeamMarhabaTitle() {
        stubConversation(Conversation.adminBroadcast());
        stubActiveMembers(activeMember(2L));
        stubDelivered();

        notifier().onMessageCreated(Message.fromSystem(CONV_ID, "an announcement", "#/help"));

        PushMessage message = capturedMessage();
        assertThat(message.title()).isEqualTo("Circle"); // system / admin "from TeamMarhaba"
        assertThat(message.route()).isEqualTo("#/help"); // the message's own validated route wins
    }

    @Test
    void anAdminBroadcastWithNoRouteOfItsOwnCarriesNoDeepLink() {
        // No conversation route exists on the allow-list, and a broadcast thread has no event page —
        // so a broadcast message that carries no route of its own deep-links nowhere (tap opens the app).
        stubConversation(Conversation.adminBroadcast());
        stubActiveMembers(activeMember(2L));
        stubDelivered();

        notifier().onMessageCreated(Message.fromSystem(CONV_ID, "no route here", null));

        assertThat(capturedMessage().route()).isNull();
    }

    @Test
    void aLongBodyIsPreviewedIntoThePush() {
        String longBody = "x".repeat(NewMessageNotifier.PUSH_PREVIEW_LENGTH + 50);
        stubConversation(Conversation.forEvent(EVENT_ID));
        stubActiveMembers(activeMember(2L));
        stubDelivered();

        notifier().onMessageCreated(Message.fromUser(CONV_ID, SENDER, longBody));

        String pushed = capturedMessage().body();
        assertThat(pushed).hasSize(NewMessageNotifier.PUSH_PREVIEW_LENGTH); // truncated + ellipsis
        assertThat(pushed).endsWith("…");
    }
}
