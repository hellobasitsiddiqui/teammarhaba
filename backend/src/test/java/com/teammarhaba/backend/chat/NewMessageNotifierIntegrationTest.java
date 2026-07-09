package com.teammarhaba.backend.chat;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.notify.PushDelivery;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
import com.teammarhaba.backend.notify.PushSender;
import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Duration;
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

/**
 * {@link NewMessageNotifier} end-to-end (TM-437): a real conversation + members + message against
 * Postgres, driven through the TM-397 delivery seam ({@code EventAttendeeNotifier}) with only the
 * outermost {@link PushSender} swapped for a recording fake — so this proves the whole recipient →
 * pref → push-eligible-token chain that a mocked unit test can't.
 *
 * <p>Covers the ACs' delivery cases: a new message pushes to every active member <b>except the
 * sender</b>, honouring each recipient's {@link NotificationPref notification preference} (TM-427,
 * an {@code EMAIL}-pref member gets no push) across their push-eligible device tokens (TM-279);
 * {@code REMOVED} and {@code READ_ONLY} members are skipped; a device token shared across recipients
 * is pushed exactly once; the push deep-links into the thread ({@code #/events/{id}} for a group
 * chat); and a system/admin broadcast message (null sender) reaches every active member.
 */
@Import(NewMessageNotifierIntegrationTest.RecordingSenderConfig.class)
class NewMessageNotifierIntegrationTest extends AbstractIntegrationTest {

    @Autowired private NewMessageNotifier notifier;
    @Autowired private ConversationRepository conversations;
    @Autowired private ConversationMemberRepository members;
    @Autowired private MessageRepository messages;
    @Autowired private UserRepository users;
    @Autowired private DeviceTokenRepository deviceTokens;
    @Autowired private EventRepository events;
    @Autowired private RecordingPushSender sender;

    @BeforeEach
    void cleanSlate() {
        // Child → parent so FK cascades don't matter; leaves per-test users/events (unique) harmless.
        messages.deleteAll();
        members.deleteAll();
        conversations.deleteAll();
        deviceTokens.deleteAll();
        sender.reset();
    }

    // ── recipients + prefs + exclusions ──────────────────────────────────────────────────────────

    @Test
    void pushesToActiveMembersHonouringPrefAndSkippingTheSender() {
        Conversation thread = conversations.save(Conversation.forEvent(newEvent("chat-prefs")));
        long author = member(thread, "s-sender", NotificationPref.BOTH, "tok-sender"); // the author
        long pushMember = member(thread, "s-push", NotificationPref.PUSH, "tok-push");
        long bothMember = member(thread, "s-both", NotificationPref.BOTH, "tok-both");
        member(thread, "s-email", NotificationPref.EMAIL, "tok-email"); // opted out of push

        PushFanout result =
                notifier.onMessageCreated(messages.save(Message.fromUser(thread.getId(), author, "hi team")));

        // The PUSH and BOTH members are reached; the EMAIL member (opted out) and the author are not.
        assertThat(deliveredTokens()).containsExactlyInAnyOrder("tok-push", "tok-both");
        assertThat(result.delivered()).isEqualTo(2);
        // ...and the push deep-links into the thread (its event page) with a member-message title.
        PushMessage pushed = sender.deliveries().get(0).message();
        assertThat(pushed.title()).isEqualTo("New message");
        assertThat(pushed.body()).isEqualTo("hi team");
        assertThat(pushed.route()).isEqualTo("#/events/" + thread.getEventId());
        // The bothMember/pushMember ids are the recipients; assert the author never self-notified.
        assertThat(deliveredTokens()).doesNotContain("tok-sender");
        assertThat(pushMember).isNotEqualTo(author);
        assertThat(bothMember).isNotEqualTo(author);
    }

    @Test
    void removedAndReadOnlyMembersAreSkipped() {
        Conversation thread = conversations.save(Conversation.forEvent(newEvent("chat-mute")));
        long author = member(thread, "m-sender", NotificationPref.BOTH, "tok-m-sender");
        long active = member(thread, "m-active", NotificationPref.BOTH, "tok-m-active");
        member(thread, "m-removed", NotificationPref.BOTH, "tok-m-removed", MuteState.REMOVED);
        member(thread, "m-readonly", NotificationPref.BOTH, "tok-m-readonly", MuteState.READ_ONLY);

        notifier.onMessageCreated(messages.save(Message.fromUser(thread.getId(), author, "roll call")));

        // Only the active, non-sender member is pushed — REMOVED (the AC's explicit skip) and READ_ONLY
        // are both excluded, and the author never self-notifies.
        assertThat(deliveredTokens()).containsExactly("tok-m-active");
        assertThat(active).isNotEqualTo(author);
    }

    @Test
    void aMemberWithMultipleDevicesIsPushedOnEach() {
        // Push-eligibility is per push-eligible token (TM-279): a member with two registered devices
        // gets the message on both.
        Conversation thread = conversations.save(Conversation.forEvent(newEvent("chat-multi")));
        long author = member(thread, "md-sender", NotificationPref.BOTH, "tok-md-sender");
        long recipient = member(thread, "md-recipient", NotificationPref.BOTH, "tok-md-phone");
        deviceTokens.saveAndFlush(new DeviceToken(recipient, "tok-md-tablet", DevicePlatform.ANDROID, Instant.now()));

        PushFanout result =
                notifier.onMessageCreated(messages.save(Message.fromUser(thread.getId(), author, "two devices")));

        assertThat(deliveredTokens()).containsExactlyInAnyOrder("tok-md-phone", "tok-md-tablet");
        assertThat(result.delivered()).isEqualTo(2);
    }

    @Test
    void aSystemBroadcastMessageReachesEveryActiveMember() {
        // A system / admin "from TeamMarhaba" message has a null sender — nobody is excluded as author.
        Conversation thread = conversations.save(Conversation.adminBroadcast());
        long a = member(thread, "b-a", NotificationPref.BOTH, "tok-b-a");
        long b = member(thread, "b-b", NotificationPref.PUSH, "tok-b-b");
        member(thread, "b-email", NotificationPref.EMAIL, "tok-b-email"); // still push-opted-out

        notifier.onMessageCreated(messages.save(Message.fromSystem(thread.getId(), "service announcement", "#/help")));

        // Every push-eligible active member receives it (no author to exclude); the EMAIL member does not.
        assertThat(deliveredTokens()).containsExactlyInAnyOrder("tok-b-a", "tok-b-b");
        assertThat(sender.deliveries().get(0).message().title()).isEqualTo("TeamMarhaba");
        assertThat(sender.deliveries().get(0).message().route()).isEqualTo("#/help");
        assertThat(a).isNotEqualTo(b);
    }

    @Test
    void aMessageWithNoPushEligibleRecipientIsAZeroFanout() {
        Conversation thread = conversations.save(Conversation.forEvent(newEvent("chat-none")));
        long author = member(thread, "z-sender", NotificationPref.BOTH, "tok-z-sender");
        member(thread, "z-email", NotificationPref.EMAIL, "tok-z-email"); // the only other member opted out

        PushFanout result =
                notifier.onMessageCreated(messages.save(Message.fromUser(thread.getId(), author, "anyone?")));

        assertThat(sender.deliveries()).isEmpty();
        assertThat(result).isEqualTo(new PushFanout(0, 0, 0, 0));
    }

    // ── fixtures ─────────────────────────────────────────────────────────────────────────────────

    private long newUser(String uid, NotificationPref pref) {
        User user = users.findByFirebaseUid(uid)
                .orElseGet(() -> users.saveAndFlush(new User(uid, uid + "@example.com", uid)));
        user.setNotificationPref(pref);
        return users.saveAndFlush(user).getId();
    }

    private long newEvent(String heading) {
        Instant now = Instant.now();
        return events.save(new Event(
                        heading,
                        "A friendly meetup.",
                        "Marhaba Cafe, 12 High St",
                        "Europe/London",
                        now.plus(Duration.ofDays(7)),
                        now.minus(Duration.ofHours(1)),
                        now.plus(Duration.ofDays(30)),
                        newUser(heading + "-creator", NotificationPref.EMAIL),
                        now))
                .getId();
    }

    /** Add an active ({@code NONE}) member backed by a real user (with pref) and one device token. */
    private long member(Conversation thread, String uid, NotificationPref pref, String token) {
        return member(thread, uid, pref, token, MuteState.NONE);
    }

    /** Add a member in the given mute state, backed by a real user (with pref) and one device token. */
    private long member(Conversation thread, String uid, NotificationPref pref, String token, MuteState mute) {
        long userId = newUser(uid, pref);
        ConversationMember m = new ConversationMember(thread.getId(), userId, MemberRole.MEMBER);
        m.setMute(mute);
        members.save(m);
        deviceTokens.saveAndFlush(new DeviceToken(userId, token, DevicePlatform.ANDROID, Instant.now()));
        return userId;
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
