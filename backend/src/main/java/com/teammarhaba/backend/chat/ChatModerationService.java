package com.teammarhaba.backend.chat;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Clock;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * App-admin thread moderation (TM-449, epic Event Chat) — the two levers an app admin uses to deal
 * with spam or abuse in a conversation thread:
 *
 * <ul>
 *   <li>{@link #removeMessage} — <b>remove a message</b>: stamp the shared soft-delete
 *       ({@link Message#softDelete}) so the message drops out of every timeline / unread read (the
 *       read path filters {@code deletedAt IS NULL}), while the row is kept — moderation never
 *       hard-deletes.</li>
 *   <li>{@link #muteMember} — <b>mute a member</b>, per case: {@link MuteState#READ_ONLY} (can still
 *       read, cannot post) or {@link MuteState#REMOVED} (loses thread access entirely), plus
 *       {@link MuteState#NONE} to reinstate. This only ever touches the {@code conversation_member}
 *       row — it never changes the member's event RSVP (a removed member is still "going").</li>
 * </ul>
 *
 * <p><b>The gate lives at the controller</b> ({@code @PreAuthorize("hasRole('ADMIN')")} on
 * {@link com.teammarhaba.backend.api.ChatModerationAdminController}), so this service is only ever
 * reached by an app admin — deliberately app-admin-only, <em>not</em> the thread's own
 * {@link MemberRole#ADMIN} (an event host is a thread admin but must not be able to moderate, per the
 * AC). The acting admin is the verified {@link VerifiedUser} caller, attributed on every audit row.
 *
 * <p><b>Not-found, not existence-leak.</b> Unlike the member-facing read/post paths — which return a
 * uniform {@code 403} for an unknown thread so ids can't be probed (TM-573) — this is a trusted admin
 * surface, so an unknown conversation / message / member is a plain {@code 404}
 * ({@link ResourceNotFoundException}), matching the admin-console convention (e.g.
 * {@code EventAdminController}). A message is additionally checked to belong to the named conversation
 * so the {@code {conversationId}/{messageId}} path can't be used to remove a message from another
 * thread.
 *
 * <p><b>Audited (TM-113).</b> Each action records one append-only audit row against the conversation —
 * {@link AuditAction#EVENT_CHAT_MESSAGE_REMOVED} / {@link AuditAction#EVENT_CHAT_MEMBER_MUTED} — in
 * the same transaction as the mutation, so an action is never silently un-audited. The durable content
 * (the message text) stays in its own row; the audit only names what was acted on.
 */
@Service
public class ChatModerationService {

    private final ConversationMemberRepository members;
    private final MessageRepository messages;
    private final UserRepository users;
    private final AuditService audit;
    private final ApplicationEventPublisher publisher;
    private final Clock clock;

    /** Audit {@code target_type} for a moderation action — the conversation it acted within. */
    private static final String TARGET_CONVERSATION = "Conversation";

    /** Spring-wired constructor — real wall clock. */
    @Autowired
    public ChatModerationService(
            ConversationMemberRepository members,
            MessageRepository messages,
            UserRepository users,
            AuditService audit,
            ApplicationEventPublisher publisher) {
        this(members, messages, users, audit, publisher, Clock.systemUTC());
    }

    /** Test-visible constructor: inject a fixed {@link Clock} so the soft-delete instant is deterministic. */
    ChatModerationService(
            ConversationMemberRepository members,
            MessageRepository messages,
            UserRepository users,
            AuditService audit,
            ApplicationEventPublisher publisher,
            Clock clock) {
        this.members = members;
        this.messages = messages;
        this.users = users;
        this.audit = audit;
        this.publisher = publisher;
        this.clock = clock;
    }

    /**
     * Remove a message from a thread (soft-delete). Loads the message, checks it belongs to
     * {@code conversationId}, stamps the shared {@link Message#softDelete} (idempotent,
     * first-moment-wins — a re-remove never rewrites the original instant), and records the audit row.
     * The message row is kept; it simply stops surfacing in any timeline read.
     *
     * @param admin          the verified app admin performing the removal (attributed on the audit row)
     * @param conversationId the thread the message must belong to
     * @param messageId      the message to remove
     * @return the soft-deleted {@link Message} (its {@code deletedAt} now stamped)
     * @throws ResourceNotFoundException {@code 404} if no such message exists in that conversation
     */
    @Transactional
    public Message removeMessage(VerifiedUser admin, Long conversationId, Long messageId) {
        // Load by id, then confirm it belongs to the named thread — so the {conversationId}/{messageId}
        // path can't remove a message that lives in a different conversation. Either miss is a plain 404.
        Message message = messages
                .findById(messageId)
                .filter(m -> m.getConversationId().equals(conversationId))
                .orElseThrow(() -> new ResourceNotFoundException("Message not found in this conversation."));

        message.softDelete(clock.instant()); // one-way, idempotent; dirty-checking flushes on commit
        messages.save(message);

        audit.record(
                admin.uid(),
                AuditAction.EVENT_CHAT_MESSAGE_REMOVED,
                TARGET_CONVERSATION,
                conversationId.toString(),
                Map.of("messageId", messageId));

        return message;
    }

    /**
     * Set a thread member's mute / removal state (the AC's "mute a member, per case"). Loads the
     * membership, applies {@code state} ({@link MuteState#READ_ONLY} = muted, {@link MuteState#REMOVED}
     * = kicked, {@link MuteState#NONE} = reinstated), and records the audit row. Idempotent — setting
     * the state a member already has still records the moderator's action.
     *
     * <p>This is deliberately the <em>only</em> row touched: the member's event RSVP
     * ({@code EventAttendance}) is never changed, so a {@code REMOVED} member is still "going" to the
     * event — they only lose access to the thread, exactly as the AC requires.
     *
     * @param admin          the verified app admin performing the change (attributed on the audit row)
     * @param conversationId the thread the member belongs to
     * @param userId         the member's {@code users.id}
     * @param state          the new mute state to apply
     * @return the updated {@link ConversationMember}
     * @throws ResourceNotFoundException {@code 404} if the user is not a member of that conversation
     */
    @Transactional
    public ConversationMember muteMember(
            VerifiedUser admin, Long conversationId, Long userId, MuteState state) {
        ConversationMember member = members
                .findByConversationIdAndUserId(conversationId, userId)
                .orElseThrow(() -> new ResourceNotFoundException("Member not found in this conversation."));

        member.setMute(state); // dirty-checking flushes on commit
        members.save(member);

        audit.record(
                admin.uid(),
                AuditAction.EVENT_CHAT_MEMBER_MUTED,
                TARGET_CONVERSATION,
                conversationId.toString(),
                Map.of("userId", userId, "mute", state.name()));

        // TM-730: a REMOVED member loses thread access, but their live SSE stream keeps delivering frames
        // until it times out (membership is only checked at connect). Revoke it — publish an AFTER_COMMIT
        // event so the stream is cut only once this removal is durable (a rollback leaves the stream). We
        // resolve userId → Firebase uid here (the stream registry keys by uid); a soft-deleted/absent
        // account resolves to null, which the listener treats as a no-op (the connect-time gate on the
        // client's reconnect is the backstop). READ_ONLY members may still READ, so their stream stays.
        if (state == MuteState.REMOVED) {
            String ownerUid = users.findById(userId).map(u -> u.getFirebaseUid()).orElse(null);
            publisher.publishEvent(new ConversationMemberRevokedEvent(conversationId, ownerUid));
        }

        return member;
    }
}
