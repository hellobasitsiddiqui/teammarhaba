package com.teammarhaba.backend.messaging;

import com.teammarhaba.backend.chat.Conversation;
import com.teammarhaba.backend.chat.ConversationMember;
import com.teammarhaba.backend.chat.ConversationMemberRepository;
import com.teammarhaba.backend.chat.ConversationRepository;
import com.teammarhaba.backend.chat.ConversationType;
import com.teammarhaba.backend.chat.MemberRole;
import com.teammarhaba.backend.chat.Message;
import com.teammarhaba.backend.chat.MessageRepository;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * The missing backend bridge (TM-588) between admin messaging (TM-441) and the chat section (TM-445).
 *
 * <p><strong>The gap this closes.</strong> TM-445 built the chat-section render for one-way admin
 * broadcasts — {@code ADMIN_BROADCAST} threads, {@code Message.isSystem()} "from TeamMarhaba" lines, a
 * tap-through deep-link CTA — contract-complete against the read API. But TM-441 delivered an admin
 * broadcast only as {@code ADMIN_MESSAGE} <em>notifications</em> (the bell inbox + a best-effort push);
 * it never created or populated an {@code ADMIN_BROADCAST} {@link Conversation}, so {@link
 * Message#fromSystem} had <em>no production caller</em> and the chat render had no real data to drive
 * off. This bridge is that caller: {@link AdminMessageService#send} invokes it inside the send
 * transaction so every broadcast is <em>also</em> persisted as a re-readable system message in chat.
 *
 * <p><strong>Membership model — a per-user personal channel (targeted, not "all users").</strong>
 * Each recipient has (at most) <em>one</em> {@code ADMIN_BROADCAST} thread — their own "from
 * TeamMarhaba" channel, keyed by {@link Conversation#getOwnerUserId()} — into which <em>every</em>
 * broadcast targeted at them is appended as a further system message. This is deliberately NOT a single
 * shared thread that every user belongs to:
 *
 * <ul>
 *   <li><b>It preserves the admin-send's targeting.</b> A broadcast resolves to a specific audience (a
 *       user / a city / an event's GOING attendees, via {@link RecipientResolver}). Writing the system
 *       message only into <em>those</em> users' personal channels means a city- or event-targeted
 *       message reaches exactly its recipients' chat sections — a single shared thread would leak every
 *       targeted broadcast to everyone who ever subscribed.</li>
 *   <li><b>It stays bounded.</b> The read side already assumes a user is in "a handful of event chats
 *       plus <em>the</em> broadcast channel, not an unbounded feed" ({@code ConversationReadService.list})
 *       and renders every {@code ADMIN_BROADCAST} thread under the one fixed "TeamMarhaba" title. One
 *       channel per user (reused across broadcasts) matches that; a thread-per-campaign would instead
 *       pile up N identical "TeamMarhaba" rows in the list.</li>
 * </ul>
 *
 * <p>The channel is created lazily on a user's first broadcast (via {@link Conversation#adminBroadcast(Long)})
 * and reused thereafter — the partial-unique index {@code uq_conversation_broadcast_owner} (V33) makes
 * it a singleton per owner. The recipient joins as a plain {@link MemberRole#MEMBER} (a per-user
 * broadcast channel has no human {@code ADMIN} — its messages are system-sent, null-sender).
 *
 * <p><strong>Augments, does not replace, the notification path (and does NOT push).</strong> This
 * bridge only <em>persists</em> the chat copy; it deliberately does not fan a push out. The recipient
 * is already notified by TM-441's existing path — the durable {@code ADMIN_MESSAGE} bell row plus its
 * best-effort push, both of which {@link AdminMessageService#send} runs and which this ticket leaves
 * <em>unaffected</em> (the AC's "existing notification delivery is unaffected"). Re-invoking the TM-437
 * new-message fan-out ({@code NewMessageNotifier}) here would push a <em>second</em> notification for
 * the same broadcast to the same recipients — a double-notify regression — so the chat copy is a
 * re-readable archive that rides the existing single push, not a new delivery channel. (A fuller
 * unification that makes the chat fan-out the <em>sole</em> push would instead have to remove
 * {@code send()}'s own push, changing the {@code AdminSendResult} contract and its OpenAPI — out of
 * this ticket's scope; see the PR's trade-off note.)
 *
 * <p><strong>Transaction.</strong> This has no transaction of its own: it is called from within
 * {@link AdminMessageService#send}'s {@code @Transactional} boundary, so its conversation/membership/
 * message writes join that transaction and commit or roll back <em>as one unit</em> with the campaign
 * header, the durable inbox rows and the audit (the TM-554 atomicity guarantee) — a broadcast can never
 * strand a chat message whose campaign rolled back, or vice versa.
 */
@Service
public class AdminBroadcastChatBridge {

    private static final Logger log = LoggerFactory.getLogger(AdminBroadcastChatBridge.class);

    private final ConversationRepository conversations;
    private final ConversationMemberRepository members;
    private final MessageRepository messages;

    public AdminBroadcastChatBridge(
            ConversationRepository conversations,
            ConversationMemberRepository members,
            MessageRepository messages) {
        this.conversations = conversations;
        this.members = members;
        this.messages = messages;
    }

    /**
     * Persist one admin broadcast as a system message in each recipient's personal "from TeamMarhaba"
     * chat channel (see the class doc). For every {@code recipientId}: resolve (creating on first use)
     * their singleton {@code ADMIN_BROADCAST} channel, ensure they are a member of it, and append a
     * {@link Message#fromSystem} carrying the broadcast's {@code body} and (already-validated) {@code
     * deepLink}. Must be called inside the caller's transaction so these writes are atomic with the send.
     *
     * <p>No push is sent here (the existing TM-441 path already notified the recipients — see the class
     * doc). {@code deepLink} is the campaign's route, already validated against the admin allow-list by
     * {@link AdminMessageService#send} before this runs; {@code null} = no CTA.
     *
     * @param recipientIds the resolved, de-duplicated recipient account ids (the send's audience snapshot)
     * @param body         the broadcast body — the exact text persisted as the system message
     * @param deepLink     the optional in-app route the message opens ({@code null} = none)
     * @return how many system messages were persisted (one per recipient)
     */
    public int bridgeToChat(Set<Long> recipientIds, String body, String deepLink) {
        int posted = 0;
        for (Long recipientId : recipientIds) {
            Conversation channel = resolveOrCreateChannel(recipientId);
            ensureMember(channel.getId(), recipientId);
            messages.save(Message.fromSystem(channel.getId(), body, deepLink));
            posted++;
        }
        log.info("Bridged admin broadcast into chat: {} system message(s) across {} personal channel(s)", posted, recipientIds.size());
        return posted;
    }

    /**
     * The recipient's singleton personal {@code ADMIN_BROADCAST} channel — found by {@code (type,
     * owner)} or created on first use. The partial-unique index makes a concurrent double-create for the
     * same owner a {@code DataIntegrityViolationException} (which fails the whole send transaction), the
     * same lazy-create-under-a-unique-index pattern the event group thread (TM-437) uses.
     */
    private Conversation resolveOrCreateChannel(Long recipientId) {
        return conversations
                .findByTypeAndOwnerUserId(ConversationType.ADMIN_BROADCAST, recipientId)
                .orElseGet(() -> conversations.save(Conversation.adminBroadcast(recipientId)));
    }

    /**
     * Add the recipient to their channel if they are not already a member (idempotent — the channel is
     * reused across broadcasts, so on the second broadcast they are already in it). A fresh membership
     * joins as a plain {@link MemberRole#MEMBER}: the channel is one-way and system-sent, so there is no
     * human {@code ADMIN} to make them.
     */
    private void ensureMember(Long conversationId, Long recipientId) {
        if (!members.existsByConversationIdAndUserId(conversationId, recipientId)) {
            members.save(new ConversationMember(conversationId, recipientId, MemberRole.MEMBER));
        }
    }
}
