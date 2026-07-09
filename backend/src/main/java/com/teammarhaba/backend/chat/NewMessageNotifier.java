package com.teammarhaba.backend.chat;

import com.teammarhaba.backend.event.EventAttendeeNotifier;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
import com.teammarhaba.backend.notify.PushRoutes;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * The reusable "new message → push fan-out" hook (TM-437, epic Event Chat wave-1). Given a message
 * that has just been created in a {@link Conversation}, it pushes a notification to <em>every active
 * member of that thread except the sender</em>, so a chat participant hears about an admin broadcast
 * (epic TM-432) or an event group message (epic TM-433) without the app open.
 *
 * <p>This is the single seam both future write paths call after they persist a {@link Message}: it
 * is deliberately transport- and endpoint-free (there is no REST surface here — the message-post
 * flows in TM-432 / TM-433 own that and invoke {@link #onMessageCreated} once the row is committed).
 *
 * <p><b>Who receives (the recipient set + exclusions).</b> Recipients are the thread's <em>active</em>
 * members, read through {@link ConversationMemberRepository#findByConversationIdAndMute} with
 * {@link MuteState#NONE} — the domain's designated fan-out recipient set. Querying {@code NONE}
 * excludes, by construction, both:
 *
 * <ul>
 *   <li>{@code REMOVED} members — the AC's explicit "skip removed" (a kicked member's row is kept so
 *       fan-out can cheaply skip them); and
 *   <li>{@code READ_ONLY} members — which the {@link MuteState} contract also excludes from push
 *       ("may read but not post; excluded from push").
 * </ul>
 *
 * The <b>sender</b> is then filtered out of that set: nobody is pushed about their own message. A
 * system / admin "from TeamMarhaba" message carries a {@code null} sender ({@link Message#isSystem()}),
 * so there is no author to exclude and every active member receives it.
 *
 * <p><b>How it delivers — reuse, never rebuild (the AC's "reuse the TM-397 seam; no new transport").</b>
 * The actual delivery is delegated to {@link EventAttendeeNotifier#pushToUsers} (TM-397, the shared
 * user-id-keyed push primitive already behind the event lifecycle / reminder / claim pushes), so this
 * hook inherits all of its rails unchanged and cannot drift from them:
 *
 * <ul>
 *   <li>people are resolved <em>through</em> {@code UserRepository}, so a soft-deleted/tombstoned
 *       account (whose membership row survives per {@code V27}) is never targeted;</li>
 *   <li>a suspended account ({@code enabled == false}) is skipped;</li>
 *   <li>the user's {@link com.teammarhaba.backend.user.NotificationPref notification preference}
 *       (TM-427) is honoured — only {@code PUSH}/{@code BOTH} receive; {@code EMAIL} is the push
 *       opt-out;</li>
 *   <li>only push-eligible device tokens (TM-279) are targeted, de-duplicated by value across
 *       recipients (a shared/handed-down device is pushed once), and delivered through the single
 *       {@link com.teammarhaba.backend.notify.PushSender} seam — the real FCM sender in production, a
 *       recording fake in tests, so no real push is sent under test.</li>
 * </ul>
 *
 * <p><b>The deep-link (the AC's "deep-links into the conversation/thread").</b> See
 * {@link #deepLinkFor}: the message's own validated route wins if it has one (e.g. an admin
 * broadcast's route); otherwise an {@code EVENT_GROUP} thread deep-links to its event page (which
 * hosts the group chat). Every emitted route is bounded to the {@link PushRoutes} allow-list, the
 * same trust boundary the rest of the push surface uses.
 *
 * <p>Like {@link EventAttendeeNotifier} this class holds no transaction of its own: it only reads
 * (the conversation, then its active members) and then fans out, leaving any surrounding transaction
 * to the caller (which invokes this after its own message-create commit). A thread whose only active
 * member is the sender — or one with no push-eligible recipient — is a no-op returning a zero
 * fan-out.
 */
@Component
public class NewMessageNotifier {

    private static final Logger log = LoggerFactory.getLogger(NewMessageNotifier.class);

    /**
     * Max chars of the message body carried in the transient push. The full text always survives in
     * the durable {@link Message} row; a push is only a preview, and an oversized FCM payload (&gt;4KB)
     * would be rejected — so a long message shows its opening and a tap opens the full thread. Mirrors
     * {@code AdminMessageService.PUSH_PREVIEW_LENGTH}.
     */
    static final int PUSH_PREVIEW_LENGTH = 500;

    /** The zero fan-out returned for every no-op path (no conversation, no recipients). */
    private static final PushFanout NOTHING = new PushFanout(0, 0, 0, 0);

    private final ConversationRepository conversations;
    private final ConversationMemberRepository members;
    private final EventAttendeeNotifier attendeeNotifier;

    public NewMessageNotifier(
            ConversationRepository conversations,
            ConversationMemberRepository members,
            EventAttendeeNotifier attendeeNotifier) {
        this.conversations = conversations;
        this.members = members;
        this.attendeeNotifier = attendeeNotifier;
    }

    /**
     * Fan a push out for a message that has just been created in a conversation (TM-437). Resolves the
     * thread's active members, excludes the sender, and delivers through the TM-397 seam (which applies
     * the pref + push-eligible-token rails). Safe to call for any newly-created message; see the class
     * doc for the full recipient/exclusion/deep-link rules.
     *
     * @param message the just-created message (carries its conversation id, sender id, body, deep-link)
     * @return the fan-out outcome (zero when there is no eligible recipient), so callers/tests can see
     *     how it resolved
     */
    public PushFanout onMessageCreated(Message message) {
        // Defensive: a soft-deleted message must never notify. A create hook won't see one, but a caller
        // that reuses this seam must not turn a moderation-removed message into a push.
        if (message.isDeleted()) {
            return NOTHING;
        }

        // The message always belongs to a conversation (FK-enforced); resolve it for the type/event the
        // deep-link needs. Absence is only possible under a concurrent hard-delete of the thread — treat
        // it as a no-op rather than throwing inside a post-commit hook.
        Conversation conversation = conversations.findById(message.getConversationId()).orElse(null);
        if (conversation == null) {
            log.warn(
                    "New-message push skipped: conversation {} for message {} not found.",
                    message.getConversationId(),
                    message.getId());
            return NOTHING;
        }

        // Recipients = the active (mute = NONE) members who have not self-muted push, minus the sender.
        // Querying NONE is the domain's fan-out recipient set, so REMOVED (the AC's explicit skip), LEFT
        // (a self-left member, TM-471) and READ_ONLY (also push-excluded by the MuteState contract) are
        // all left out here. The self-mute filter (TM-471) then drops an otherwise-active member who has
        // silenced THIS thread's push — they stay a full member (they still read + post), they just get
        // no new-message push (the AC's "a self-muted member gets no chat pushes"; the same recipient
        // rule any @everyone/@here mention fan-out, TM-469, must reuse). A null sender (system/admin
        // message) excludes nobody — userId.equals(null) is false — so every eligible member receives it.
        Long senderId = message.getSenderId();
        List<Long> recipients = members
                .findByConversationIdAndMute(message.getConversationId(), MuteState.NONE).stream()
                .filter(member -> !member.isNotificationsMuted()) // TM-471: skip self-muted members
                .map(ConversationMember::getUserId)
                .filter(userId -> !userId.equals(senderId))
                .toList();
        if (recipients.isEmpty()) {
            return NOTHING; // nobody active but the sender, or an empty thread — nothing to push
        }

        PushMessage push =
                new PushMessage(titleFor(message), preview(message.getBody()), deepLinkFor(conversation, message));

        // Delegate delivery to the TM-397 seam: it applies the notification-pref (TM-427) and
        // push-eligible-token (TM-279) rails, de-dupes shared tokens, and sends through the PushSender
        // seam (a recording fake under test) — so this hook never re-implements token/pref/FCM handling.
        PushFanout fanout = attendeeNotifier.pushToUsers(recipients, push);
        log.info(
                "New-message push for conversation {} (message {}): recipients={}, {}",
                message.getConversationId(),
                message.getId(),
                recipients.size(),
                fanout);
        return fanout;
    }

    /**
     * The push headline. A chat message has no title of its own, so this is contextual: a system / admin
     * "from TeamMarhaba" message ({@code null} sender) is headed {@code "TeamMarhaba"}; an ordinary
     * member message is headed {@code "New message"}. The body carries the actual text (a preview).
     */
    private static String titleFor(Message message) {
        return message.isSystem() ? "TeamMarhaba" : "New message";
    }

    /**
     * The deep-link route the push opens on tap — "into the conversation/thread" (an AC):
     *
     * <ol>
     *   <li>the message's own route if it carries a valid one (e.g. an admin broadcast's deep-link),
     *       preferred so a message that already points somewhere keeps pointing there;</li>
     *   <li>otherwise, for an {@code EVENT_GROUP} thread, the event-detail route {@code #/events/{id}} —
     *       the event page hosts the group chat, so it is the thread's destination. There is no
     *       standalone conversation route on the allow-list (and this ticket adds no new route), so an
     *       admin broadcast with no route of its own carries {@code null} (a tap just opens the app).</li>
     * </ol>
     *
     * <p>Every non-null result is on the {@link PushRoutes} allow-list — the message's own route is
     * re-checked with {@link PushRoutes#isAllowed} (so a stale/off-list stored value can never reach the
     * wire, and the {@link PushMessage} constructor's last-line guard never trips), and
     * {@link PushRoutes#eventDetail} is allow-listed by construction.
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
     * The body carried in the transient push: the whole message if it fits, otherwise its first
     * {@link #PUSH_PREVIEW_LENGTH} chars with a trailing ellipsis. The durable {@link Message} row keeps
     * the full text — this only bounds the push so a long message can't exceed FCM's payload limit.
     */
    static String preview(String body) {
        if (body.length() <= PUSH_PREVIEW_LENGTH) {
            return body;
        }
        return body.substring(0, PUSH_PREVIEW_LENGTH - 1).stripTrailing() + "…";
    }
}
