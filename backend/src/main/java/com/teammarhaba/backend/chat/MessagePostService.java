package com.teammarhaba.backend.chat;

import com.teammarhaba.backend.api.ConversationMessageResponse;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.EventChatLifecycleService;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.ConflictException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The event-chat write path (TM-447, epic Event Chat wave-2): an attendee posting a message to their
 * event's group thread. This is the write sibling of the read projection
 * ({@link MessageReactionService#threadMessages}) and the first consumer of the whole chat
 * foundation's write seam:
 *
 * <ul>
 *   <li>the shared message store (TM-435) — persists a {@link Message};</li>
 *   <li>the thread-lifecycle / close policy (TM-446) — rejects a post to a closed thread via
 *       {@link EventChatLifecycleService#isThreadReadOnly}, which it <em>consumes</em> rather than
 *       re-deriving the close window here;</li>
 *   <li>the push fan-out hook (TM-437) — triggers {@link NewMessageNotifier#onMessageCreated} so
 *       every other active member hears about the message without the app open.</li>
 * </ul>
 *
 * <p><b>Identity is always the verified caller.</b> The acting member is resolved from the
 * {@link VerifiedUser} principal via {@link UserService#provision} (the same just-in-time
 * provisioning the rest of the {@code /me} surface uses), never from a client-supplied id — so a
 * caller can only ever post as themselves.
 *
 * <p><b>The gate (per the AC), in order:</b>
 * <ol>
 *   <li>an unknown thread → {@code 404} ({@link ResourceNotFoundException}), mirroring the read gate
 *       so the not-found path is uniform;</li>
 *   <li>the caller must be a member whose {@link MuteState} is {@link MuteState#NONE NONE} — a
 *       non-member, a {@link MuteState#REMOVED REMOVED} (kicked) member, and a
 *       {@link MuteState#READ_ONLY READ_ONLY} (muted) member are all {@code 403}
 *       ({@link AccessDeniedException}). Posting is stricter than reacting: reactions allow a
 *       {@code READ_ONLY} member (a read-side signal), but the AC gates posting on "non-removed,
 *       <em>non-read-only-muted</em>", so anything but an active member is denied;</li>
 *   <li>the thread must be open → a closed / read-only thread is {@code 409}
 *       ({@link ConflictException}). For an event thread this is TM-446's
 *       {@link EventChatLifecycleService#isThreadReadOnly} (manually soft-closed, or past its policy
 *       close time); a soft-deleted event has no live chat, so it too reads as closed.</li>
 * </ol>
 *
 * <p><b>Body length</b> is bounded at the edge by Bean Validation on {@code PostMessageRequest}
 * (≤ {@code 500}); this service takes the already-validated text.
 *
 * <p><b>Ordering (all in one transaction, like {@code AdminMessageService}):</b> persist the message
 * (flushed so the DB-authoritative {@code createdAt} reads straight back), record one
 * {@link AuditAction#EVENT_CHAT_MESSAGE_POSTED} audit row, then fan the push out. The push is the
 * last step and nothing follows that could roll the message back, so calling the notifier in-line
 * (rather than strictly post-commit) never pushes about a message that then disappears.
 */
@Service
public class MessagePostService {

    private final UserService users;
    private final ConversationRepository conversations;
    private final ConversationMemberRepository members;
    private final MessageRepository messages;
    private final EventRepository events;
    private final EventChatLifecycleService lifecycle;
    private final NewMessageNotifier notifier;
    private final AuditService audit;
    private final Clock clock;

    /** Audit {@code target_type} for a posted chat message — the conversation it landed in. */
    private static final String TARGET_CONVERSATION = "Conversation";

    /** Spring-wired constructor — real wall clock. */
    @Autowired
    public MessagePostService(
            UserService users,
            ConversationRepository conversations,
            ConversationMemberRepository members,
            MessageRepository messages,
            EventRepository events,
            EventChatLifecycleService lifecycle,
            NewMessageNotifier notifier,
            AuditService audit) {
        this(users, conversations, members, messages, events, lifecycle, notifier, audit, Clock.systemUTC());
    }

    /** Test-visible constructor: inject a fixed {@link Clock} to drive the close-policy time deterministically. */
    MessagePostService(
            UserService users,
            ConversationRepository conversations,
            ConversationMemberRepository members,
            MessageRepository messages,
            EventRepository events,
            EventChatLifecycleService lifecycle,
            NewMessageNotifier notifier,
            AuditService audit,
            Clock clock) {
        this.users = users;
        this.conversations = conversations;
        this.members = members;
        this.messages = messages;
        this.events = events;
        this.lifecycle = lifecycle;
        this.notifier = notifier;
        this.audit = audit;
        this.clock = clock;
    }

    /**
     * Post {@code body} to thread {@code conversationId} as the verified caller. Applies the
     * member + open-thread gate, persists the message, audits the post, and triggers the push
     * fan-out. Returns the created message as the read DTO (with an empty reaction summary — a brand
     * new message has no reactions yet) so the client can append it to the timeline optimistically.
     *
     * @throws ResourceNotFoundException {@code 404} if the thread does not exist
     * @throws AccessDeniedException     {@code 403} if the caller is not an active (NONE) member
     * @throws ConflictException         {@code 409} if the thread is closed / read-only
     */
    @Transactional
    public ConversationMessageResponse post(VerifiedUser caller, Long conversationId, String body) {
        Long userId = users.provision(caller).getId();

        // 404 first (before the membership check) so a missing thread is uniform with the read gate.
        Conversation conversation = conversations
                .findById(conversationId)
                .orElseThrow(() -> new ResourceNotFoundException("conversation " + conversationId + " not found"));

        requireActiveMember(conversationId, userId);
        requireOpenThread(conversation);

        // Persist, flushing so the @Generated DB-authoritative created_at is read straight back for the DTO.
        Message saved = messages.saveAndFlush(Message.fromUser(conversationId, userId, body));

        // Audit the post (the durable text lives in the message row; the audit only names it).
        audit.record(
                caller.uid(),
                AuditAction.EVENT_CHAT_MESSAGE_POSTED,
                TARGET_CONVERSATION,
                conversationId.toString(),
                Map.of("messageId", saved.getId()));

        // Fan the new-message push out to every other active member — reuse the TM-437 hook, don't rebuild.
        notifier.onMessageCreated(saved);

        // A freshly posted message carries no reactions yet.
        return ConversationMessageResponse.from(saved, List.of());
    }

    /**
     * The AC's post gate: the caller must be a member of the thread whose mute state is
     * {@link MuteState#NONE} — an active member. A non-member, a {@code REMOVED} member and a
     * {@code READ_ONLY} member are all denied with a uniform {@code 403} (the copy distinguishes only
     * "not a member" from "muted", which a read-only member — who can already read — already knows).
     */
    private void requireActiveMember(Long conversationId, Long userId) {
        MuteState mute = members
                .findByConversationIdAndUserId(conversationId, userId)
                .map(ConversationMember::getMute)
                .orElseThrow(() -> new AccessDeniedException("You are not a member of this thread."));
        switch (mute) {
            case NONE -> {
                /* active member — allowed to post */
            }
            case READ_ONLY -> throw new AccessDeniedException("You are muted in this thread and cannot post.");
            case REMOVED -> throw new AccessDeniedException("You are not a member of this thread.");
        }
    }

    /**
     * Posting is only allowed while the thread is open. For an event thread this delegates to TM-446's
     * {@link EventChatLifecycleService#isThreadReadOnly} — the single resolver of "manually closed, or
     * past the close-policy window" — so this path never re-implements the close window. A soft-deleted
     * event ({@code findById} empty under the entity's {@code @SQLRestriction}) has no live chat and is
     * treated as closed. A non-event (admin broadcast) thread has no close policy, so it falls back to
     * the plain soft-close flag.
     */
    private void requireOpenThread(Conversation conversation) {
        Long eventId = conversation.getEventId();
        boolean closed;
        if (eventId != null) {
            Instant now = clock.instant();
            closed = events
                    .findById(eventId)
                    .map(event -> lifecycle.isThreadReadOnly(event, now))
                    .orElse(true); // soft-deleted / missing event → no live chat
        } else {
            closed = conversation.isClosed();
        }
        if (closed) {
            throw new ConflictException("This thread is closed; you can no longer post.");
        }
    }
}
