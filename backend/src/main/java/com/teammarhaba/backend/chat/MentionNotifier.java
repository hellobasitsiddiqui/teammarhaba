package com.teammarhaba.backend.chat;

import com.teammarhaba.backend.notify.NotificationType;
import com.teammarhaba.backend.notify.NotificationWriter;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushRoutes;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * The @mention → durable-notification hook (TM-469, epic Event Chat wave-4). Given a message that has
 * just been posted, it re-parses the body for mentions ({@link MentionResolver}), resolves them to the
 * thread's active members, and writes each mentioned member a durable inbox notification
 * ({@link NotificationWriter}, the TM-452/TM-453 store).
 *
 * <p><b>Why a durable notification and NOT a second push.</b> Every mention recipient is, by
 * definition, an active member of the thread, so they already receive the ordinary new-message
 * <em>push</em> ({@link NewMessageNotifier}, TM-437) for this very message — that is the AC's "+ push",
 * delivered by the existing rail with its deep-link into the thread. What an ordinary chat message does
 * NOT do is leave a durable <b>bell/panel row</b> (a plain message only pushes and is gone). Being
 * @mentioned is exactly the case that warrants one, so this hook adds the store row the AC calls for —
 * reusing {@link NotificationWriter} unchanged — instead of firing a duplicate push at someone who is
 * already being pushed. This keeps mentions from double-notifying while still satisfying
 * "notification (store) + push".
 *
 * <p><b>Who gets the row (the recipient rule — the same one {@link NewMessageNotifier} uses).</b> The
 * candidate set is built from the thread's <em>active</em> ({@link MuteState#NONE}) members:
 *
 * <ul>
 *   <li>an <b>individual</b> {@code @Name} resolves only to a member of that active roster — a name
 *       that matches no member notifies no-one ("non-members ignored");</li>
 *   <li>{@code @everyone} expands to every active member;</li>
 *   <li>{@code @here} expands to the active members currently <b>online</b> — the intersection of the
 *       active roster with {@link ChatStreamService#onlineOwnerUids} (best-effort, single-instance;
 *       see that method).</li>
 * </ul>
 *
 * The <b>sender</b> is then removed (you never notify yourself for your own mention), and any member
 * who has <b>self-muted</b> this thread ({@link ConversationMember#isNotificationsMuted}, TM-471) is
 * dropped — "respecting each user's self-mute", the same filter the push fan-out applies. Note the
 * inbox write is otherwise notification-pref-independent (an {@code EMAIL}-pref member still reads the
 * bell), so a non-self-muted {@code EMAIL} member who is mentioned still gets the durable row even
 * though the push rail skipped their push — which is the point of the durable store.
 *
 * <p><b>Idempotency.</b> Each write carries {@code conversation:{id}:mention:{messageId}} as its
 * source ref, so re-running this hook for the same message (an at-least-once redelivery of the
 * post-commit event) can never double-write a member's inbox — the {@link NotificationWriter}'s
 * per-{@code (user,type,sourceRef)} guard skips the duplicate. Mentioning the same person twice in one
 * body is likewise one row (the resolver de-duplicates ids).
 *
 * <p><b>Guardrail (the AC's open question).</b> {@code @everyone}/{@code @here} are allowed for any
 * active member here — no host/admin gate and no rate limit in this slice. That guardrail is
 * deliberately deferred: it is an anti-spam policy on top of a working feature, and the AC lists it as
 * "may be limited … confirm during build". Gating mass-mentions to the thread {@code ADMIN} (the
 * organiser) or rate-limiting them is a clean follow-up that would slot in right here, at the keyword
 * expansion, without touching the resolution or delivery below.
 *
 * <p>Like {@link NewMessageNotifier} this component holds no transaction of its own: it only reads
 * (the conversation, its members, the mentioned users) and then calls {@link NotificationWriter}, whose
 * public methods run {@code REQUIRES_NEW} so they are safe to invoke from the {@code AFTER_COMMIT}
 * listener ({@link MessageCreatedMentionListener}) that drives this — after the message's own write has
 * committed, so a rolled-back post mentions nobody.
 */
@Component
public class MentionNotifier {

    private static final Logger log = LoggerFactory.getLogger(MentionNotifier.class);

    /**
     * Max chars of the message body carried in the durable notification's preview line. The full text
     * always survives in the {@link Message} row and the thread; the bell row only needs a glimpse.
     */
    static final int PREVIEW_LENGTH = 140;

    private final ConversationRepository conversations;
    private final ConversationMemberRepository members;
    private final UserRepository users;
    private final ChatStreamService streams;
    private final NotificationWriter notificationWriter;

    public MentionNotifier(
            ConversationRepository conversations,
            ConversationMemberRepository members,
            UserRepository users,
            ChatStreamService streams,
            NotificationWriter notificationWriter) {
        this.conversations = conversations;
        this.members = members;
        this.users = users;
        this.streams = streams;
        this.notificationWriter = notificationWriter;
    }

    /**
     * Parse {@code message} for @mentions and write each mentioned active member a durable
     * {@link NotificationType#CHAT_MENTION} inbox row (see the class doc for the recipient rules).
     * Safe to call for any just-created message; a soft-deleted or system (author-less) message, a
     * body with no mentions, or a thread whose only mentioned member is the sender are all a no-op.
     *
     * @param message the just-committed message to scan
     * @return how many inbox rows were actually written (0 on every no-op path)
     */
    public int notifyMentions(Message message) {
        // A moderation-removed message must never notify; a system/admin message (null sender) has no
        // author "mentioning" anyone in this slice, so it is skipped too.
        if (message.isDeleted() || message.isSystem()) {
            return 0;
        }
        Conversation conversation = conversations.findById(message.getConversationId()).orElse(null);
        if (conversation == null) {
            return 0; // thread hard-deleted out from under us — nothing to mention into
        }

        // The active roster: (member row, display name). Members are resolved THROUGH the User aggregate
        // so a tombstoned account (whose membership row survives) contributes no mentionable name and no
        // recipient. One batch read.
        List<ConversationMember> activeMembers =
                members.findByConversationIdAndMute(message.getConversationId(), MuteState.NONE);
        if (activeMembers.isEmpty()) {
            return 0;
        }
        Map<Long, User> byId = users
                .findAllById(activeMembers.stream().map(ConversationMember::getUserId).toList()).stream()
                .collect(Collectors.toMap(User::getId, Function.identity()));

        List<MentionResolver.Member> roster = activeMembers.stream()
                .map(member -> byId.get(member.getUserId()))
                .filter(user -> user != null)
                .map(user -> new MentionResolver.Member(user.getId(), user.getDisplayName()))
                .toList();

        MentionResolver.Resolution resolution = MentionResolver.resolve(message.getBody(), roster);
        if (resolution.isEmpty()) {
            return 0;
        }

        // Expand the resolution to a concrete target set over the active roster.
        Set<Long> activeIds =
                activeMembers.stream().map(ConversationMember::getUserId).collect(Collectors.toCollection(LinkedHashSet::new));
        Set<Long> targets = new LinkedHashSet<>(resolution.userIds());
        if (resolution.everyone()) {
            targets.addAll(activeIds);
        }
        if (resolution.here()) {
            targets.addAll(onlineActiveIds(message.getConversationId(), activeIds));
        }

        // Drop the sender (never notify yourself) and any self-muted member (respect TM-471), keeping
        // only genuine active members. `receivesPush()` is exactly "active and not self-muted".
        Long senderId = message.getSenderId();
        Set<Long> notMuted = activeMembers.stream()
                .filter(ConversationMember::receivesPush)
                .map(ConversationMember::getUserId)
                .collect(Collectors.toSet());
        List<Long> recipients = targets.stream()
                .filter(id -> !id.equals(senderId))
                .filter(notMuted::contains)
                .toList();
        if (recipients.isEmpty()) {
            return 0;
        }

        PushMessage row = new PushMessage(
                titleFor(byId.get(senderId)),
                preview(message.getBody()),
                deepLinkFor(conversation, message));
        String sourceRef = "conversation:" + message.getConversationId() + ":mention:" + message.getId();
        int written = notificationWriter.writeSystem(NotificationType.CHAT_MENTION, recipients, row, sourceRef);
        log.info(
                "Mention notify for conversation {} (message {}): everyone={}, here={}, individuals={}, "
                        + "recipients={}, written={}",
                message.getConversationId(),
                message.getId(),
                resolution.everyone(),
                resolution.here(),
                resolution.userIds().size(),
                recipients.size(),
                written);
        return written;
    }

    /**
     * The active members currently connected to the thread's live stream (TM-464), for {@code @here}:
     * map the online owner uids to user ids and intersect with the active roster, so an online but
     * removed/read-only member (who could still hold a stale stream) is never a target. Best-effort and
     * single-instance — see {@link ChatStreamService#onlineOwnerUids}.
     */
    private Set<Long> onlineActiveIds(Long conversationId, Set<Long> activeIds) {
        Set<String> onlineUids = streams.onlineOwnerUids(conversationId);
        if (onlineUids.isEmpty()) {
            return Set.of();
        }
        return onlineUids.stream()
                .map(users::findByFirebaseUid)
                .flatMap(Optional::stream)
                .map(User::getId)
                .filter(activeIds::contains)
                .collect(Collectors.toSet());
    }

    /**
     * The bell-row headline: "{sender} mentioned you" when the sender resolves to a live account,
     * otherwise the neutral "You were mentioned" (a tombstoned/blank-named author still yields a
     * sensible row). Never blank, as {@link PushMessage} requires.
     */
    private static String titleFor(User sender) {
        if (sender != null && sender.getDisplayName() != null && !sender.getDisplayName().isBlank()) {
            return sender.getDisplayName() + " mentioned you";
        }
        return "You were mentioned";
    }

    /**
     * The deep-link the notification opens on tap — "into the conversation/thread" (an AC). Prefers the
     * message's own allow-listed route (an ordinary message rarely carries one), else the event-detail
     * route for an {@code EVENT_GROUP} thread (the event page hosts the group chat), else {@code null}
     * (a tap just opens the app). Mirrors {@link NewMessageNotifier}'s rule; every non-null result is on
     * the {@link PushRoutes} allow-list, so the {@link PushMessage} guard never trips.
     */
    private static String deepLinkFor(Conversation conversation, Message message) {
        String own = message.getDeepLink();
        if (own != null && PushRoutes.isAllowed(own)) {
            return own;
        }
        if (conversation.getType() == ConversationType.EVENT_GROUP && conversation.getEventId() != null) {
            return PushRoutes.eventDetail(conversation.getEventId());
        }
        return null;
    }

    /**
     * The preview line: the whole body if short, else its first {@link #PREVIEW_LENGTH} chars with a
     * trailing ellipsis. Kept independent of the push preview so the bell row's length can differ.
     */
    static String preview(String body) {
        if (body.length() <= PREVIEW_LENGTH) {
            return body;
        }
        return body.substring(0, PREVIEW_LENGTH - 1).stripTrailing() + "…";
    }
}
