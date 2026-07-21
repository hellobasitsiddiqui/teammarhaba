package com.teammarhaba.backend.chat;

import com.teammarhaba.backend.api.ConversationMessageResponse;
import com.teammarhaba.backend.api.EmojiReactionCount;
import com.teammarhaba.backend.api.MessageReadReceipt;
import com.teammarhaba.backend.api.QuotedMessage;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.EventChatLifecycleService;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.ConflictException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Author self-service over a member's OWN chat message (TM-467, epic Event Chat) — the write path that
 * lets the person who posted a message <b>edit</b> it (fix a typo / reword) or <b>delete</b> it (take it
 * back). It is the author-gated sibling of admin moderation ({@link ChatModerationService}, TM-449):
 * both reuse the shared {@link Message#softDelete} for removal, but this service is reached by the
 * <em>author</em> over the member surface, not an app admin over the admin surface.
 *
 * <p><b>Identity is always the verified caller.</b> The acting user is resolved from the
 * {@link VerifiedUser} principal via {@link UserService#provision} (the same JIT provisioning the rest
 * of the {@code /me} surface uses), never a client-supplied id, so a caller can only ever act on a
 * message the token proves is theirs.
 *
 * <h2>The gates (per the AC)</h2>
 *
 * <p><b>Ownership is the first gate, and it is {@code 403} — not a not-found oracle.</b> The AC is
 * explicit: the endpoints are owner-scoped, so anyone who isn't the author gets a {@code 403}. That is a
 * deliberate divergence from the message-scoped reaction endpoints (which fold non-member onto the
 * {@code 404} not-found path, TM-576): here the caller is editing/deleting a message they can already
 * see in the thread they're in, so "you can't touch someone else's message" is an honest {@code 403},
 * not a hidden-existence case. The message is loaded by id and must belong to the named conversation and
 * be live (not already soft-deleted) — any of those misses is a plain {@code 404}
 * ({@link ResourceNotFoundException}); once it resolves, a non-author caller (including a system message,
 * whose {@code senderId} is {@code null} and so is nobody's) is a {@code 403}
 * ({@link AccessDeniedException}).
 *
 * <ul>
 *   <li><b>Edit</b> is additionally gated on:
 *       <ol>
 *         <li>the thread being <b>open</b> — a closed / read-only thread is a {@code 409}
 *             ({@link ConflictException}), reusing TM-446's {@link EventChatLifecycleService#isThreadReadOnly}
 *             exactly as the post + reaction paths do (so an edit freezes on the same window a post does);
 *         <li>the <b>edit window</b> — an edit is only allowed within {@link #EDIT_WINDOW} (~5 minutes) of
 *             the message's post instant, then it's locked; past the window is a {@code 409}
 *             ({@link ConflictException}), enforced server-side against the DB-authoritative
 *             {@code created_at} so a client can't reopen it.
 *       </ol>
 *   <li><b>Delete</b> is allowed <b>anytime</b> (the AC): an author can always take their own message
 *       back, even on a closed thread and long after posting — so delete applies neither the open-thread
 *       nor the edit-window gate, only ownership.
 * </ul>
 *
 * <p><b>Audited</b> (TM-113): each action records one append-only audit row against the conversation —
 * {@link AuditAction#EVENT_CHAT_MESSAGE_EDITED} / {@link AuditAction#EVENT_CHAT_MESSAGE_DELETED} — in the
 * same transaction as the mutation, so an action is never silently un-audited.
 *
 * <p><b>Live re-render</b> (TM-464): each mutation publishes an in-transaction domain event
 * ({@link MessageEditedEvent} / {@link MessageDeletedEvent}) consumed {@code AFTER_COMMIT} by
 * {@link MessageMutationStreamListener}, which broadcasts the change over SSE to members currently
 * connected to the thread — so an edit re-renders and a delete drops live, without a poll. Publishing
 * (rather than broadcasting in-line) means a rolled-back mutation broadcasts nothing, and the SSE send
 * never holds the write connection. Neither publishes the push fan-out — editing/deleting must not
 * re-notify the thread.
 */
@Service
public class MessageAuthorService {

    /**
     * How long after a message is posted its author may still edit it (the AC's "~5 minutes"), then it
     * locks. Delete has no such window — an author can always take a message back. Enforced against the
     * DB-authoritative {@code created_at} (never the app clock) so the cutoff can't be caller-skewed.
     */
    static final Duration EDIT_WINDOW = Duration.ofMinutes(5);

    private final UserService users;
    private final ConversationRepository conversations;
    private final MessageRepository messages;
    private final EventRepository events;
    private final EventChatLifecycleService lifecycle;
    private final MessageReactionService reactionSummaries;
    private final ApplicationEventPublisher publisher;
    private final AuditService audit;
    private final Clock clock;
    private final ThreadOpenGate threadGate;

    /** Audit {@code target_type} for an author edit/delete — the conversation it acted within. */
    private static final String TARGET_CONVERSATION = "Conversation";

    /** Spring-wired constructor — real wall clock. */
    @Autowired
    public MessageAuthorService(
            UserService users,
            ConversationRepository conversations,
            MessageRepository messages,
            EventRepository events,
            EventChatLifecycleService lifecycle,
            MessageReactionService reactionSummaries,
            ApplicationEventPublisher publisher,
            AuditService audit) {
        this(users, conversations, messages, events, lifecycle, reactionSummaries, publisher, audit, Clock.systemUTC());
    }

    /** Test-visible constructor: inject a fixed {@link Clock} to drive the edit window deterministically. */
    MessageAuthorService(
            UserService users,
            ConversationRepository conversations,
            MessageRepository messages,
            EventRepository events,
            EventChatLifecycleService lifecycle,
            MessageReactionService reactionSummaries,
            ApplicationEventPublisher publisher,
            AuditService audit,
            Clock clock) {
        this.users = users;
        this.conversations = conversations;
        this.messages = messages;
        this.events = events;
        this.lifecycle = lifecycle;
        this.reactionSummaries = reactionSummaries;
        this.publisher = publisher;
        this.audit = audit;
        this.clock = clock;
        this.threadGate = new ThreadOpenGate(events, lifecycle, clock);
    }

    /**
     * Edit the caller's own message {@code messageId} in thread {@code conversationId} to {@code newBody}
     * (TM-467). Applies the ownership gate ({@code 403} for a non-author), the open-thread gate ({@code
     * 409} on a closed thread), and the edit-window gate ({@code 409} once past {@link #EDIT_WINDOW}),
     * rewrites the body + stamps {@code editedAt}, audits the edit, and publishes the
     * {@link MessageEditedEvent} that live-re-renders it after commit. Returns the edited message as the
     * read DTO — its current reactions (edits don't change reactions, so they're carried through), the
     * quoted-parent snippet when it's a reply, an empty read receipt (the client patches only body +
     * {@code editedAt} and keeps its own receipt), and {@code mine == true} (it's definitionally the
     * caller's) — so the author's client can reconcile its optimistic edit.
     *
     * @throws ResourceNotFoundException {@code 404} if no live message with that id exists in the thread
     * @throws AccessDeniedException     {@code 403} if the caller is not the message's author
     * @throws ConflictException         {@code 409} if the thread is closed, or the edit window has passed
     */
    @Transactional
    public ConversationMessageResponse editOwnMessage(
            VerifiedUser caller, Long conversationId, Long messageId, String newBody) {
        User author = users.provision(caller);
        Long userId = author.getId();
        Message message = requireOwnLiveMessage(conversationId, messageId, userId);

        // Edit-only gates: the thread must be open, and the edit must be within the window. Delete has
        // neither (an author can take a message back anytime, even on a closed thread) — see below.
        requireOpenThread(conversationId);
        requireWithinEditWindow(message);

        message.edit(newBody, clock.instant()); // rewrite body + stamp editedAt; dirty-checking flushes
        messages.save(message);

        audit.record(
                caller.uid(),
                AuditAction.EVENT_CHAT_MESSAGE_EDITED,
                TARGET_CONVERSATION,
                conversationId.toString(),
                Map.of("messageId", messageId));

        // Live re-render (TM-464) after commit; never a push — an edit must not re-notify the thread.
        publisher.publishEvent(new MessageEditedEvent(message));

        // The edited message's own reaction chips are unchanged by the edit, so carry them through (the
        // client patches only body + editedAt, but the wire DTO stays honest). replyTo resolves the
        // parent for a reply; the receipt is empty (the client keeps its authoritative one). mine == true.
        List<EmojiReactionCount> reactions = reactionSummaries
                .summariesFor(userId, List.of(messageId))
                .getOrDefault(messageId, List.of());
        return ConversationMessageResponse.from(
                message,
                author.getDisplayName(), // sender identity for the incoming-bubble label (TM-828)
                reactions,
                MessageReadReceipt.empty(),
                quotedParent(message),
                true);
    }

    /**
     * Delete (soft-delete) the caller's own message {@code messageId} in thread {@code conversationId}
     * (TM-467). Applies ONLY the ownership gate ({@code 403} for a non-author) — delete is allowed
     * anytime, so there is no open-thread or window check — stamps the shared one-way {@link
     * Message#softDelete} (so it drops out of every timeline read), audits the delete, and publishes the
     * {@link MessageDeletedEvent} that drops it live after commit. Returns a thin acknowledgement (the
     * message is gone from the timeline, so its body isn't echoed).
     *
     * @throws ResourceNotFoundException {@code 404} if no live message with that id exists in the thread
     * @throws AccessDeniedException     {@code 403} if the caller is not the message's author
     */
    @Transactional
    public com.teammarhaba.backend.api.RemovedMessageResponse deleteOwnMessage(
            VerifiedUser caller, Long conversationId, Long messageId) {
        Long userId = users.provision(caller).getId();
        Message message = requireOwnLiveMessage(conversationId, messageId, userId);

        Instant when = clock.instant();
        message.softDelete(when); // one-way, first-moment-wins; dirty-checking flushes on commit
        messages.save(message);

        audit.record(
                caller.uid(),
                AuditAction.EVENT_CHAT_MESSAGE_DELETED,
                TARGET_CONVERSATION,
                conversationId.toString(),
                Map.of("messageId", messageId));

        // Live drop (TM-464) after commit; never a push.
        publisher.publishEvent(new MessageDeletedEvent(conversationId, messageId, message.getDeletedAt()));

        return com.teammarhaba.backend.api.RemovedMessageResponse.from(message);
    }

    /**
     * Resolve a LIVE message that belongs to {@code conversationId} AND was authored by {@code userId},
     * or throw — the shared ownership gate for edit + delete. A missing / foreign (other-thread) /
     * already-soft-deleted message is a {@code 404} ({@link ResourceNotFoundException}); a message that
     * resolves but was authored by someone else (or is a system message, {@code senderId == null}) is a
     * {@code 403} ({@link AccessDeniedException}) — the AC's "owner-scoped, 403 for anyone else". Loading
     * by id then checking conversation membership of the message means the {@code {conversationId}/
     * {messageId}} path can't act on a message in another thread.
     */
    private Message requireOwnLiveMessage(Long conversationId, Long messageId, Long userId) {
        Message message = messages
                .findById(messageId)
                .filter(m -> m.getConversationId().equals(conversationId) && !m.isDeleted())
                .orElseThrow(() -> new ResourceNotFoundException("Message not found in this conversation."));
        if (!userId.equals(message.getSenderId())) {
            // Not the author (or a system message with no author) — owner-scoped, so a uniform 403.
            throw new AccessDeniedException("You can only edit or delete your own messages.");
        }
        return message;
    }

    /**
     * Edit is only allowed while the thread is open — a closed / read-only thread is a {@code 409}. For
     * an event thread this reuses TM-446's {@link EventChatLifecycleService#isThreadReadOnly} (manually
     * soft-closed, or past the per-event close-time policy), so an edit and a post freeze on exactly the
     * same window; a soft-deleted / missing event has no live chat and reads as closed. A non-event
     * (admin-broadcast) thread has no close policy, so it falls back to the plain soft-close flag. Mirrors
     * {@link MessagePostService} / {@link MessageReactionService} rather than re-deriving the window.
     */
    private void requireOpenThread(Long conversationId) {
        Conversation conversation = conversations
                .findById(conversationId)
                .orElseThrow(() -> new ResourceNotFoundException("Message not found in this conversation."));
        // Shared close-window decision (TM-857) — post / react / edit can't drift; edit-specific 409 wording.
        threadGate.requireOpen(conversation, "This thread is closed; you can no longer edit this message.");
    }

    /**
     * Enforce the ~5-minute edit window (the AC) against the message's DB-authoritative {@code created_at}
     * — a {@code 409} once the message is older than {@link #EDIT_WINDOW}. Using {@code created_at} (the
     * DB clock) rather than any client-supplied time means the cutoff can't be reopened by a skewed
     * client; the boundary is inclusive (an edit exactly at the window edge is still allowed).
     */
    private void requireWithinEditWindow(Message message) {
        Instant deadline = message.getCreatedAt().plus(EDIT_WINDOW);
        if (clock.instant().isAfter(deadline)) {
            throw new ConflictException(
                    "The time window for editing this message has passed; it can no longer be edited.");
        }
    }

    /**
     * The quoted-parent snippet for an edited reply (TM-466): {@code null} when the message isn't a
     * reply, otherwise resolved from the parent (or "unavailable" when it's been removed) — mirrors the
     * read path so an edited reply's echo still renders its quote. Loaded WITHOUT the deleted filter so a
     * soft-deleted parent surfaces as "message unavailable" rather than vanishing.
     */
    private QuotedMessage quotedParent(Message message) {
        Long replyToId = message.getReplyToMessageId();
        if (replyToId == null) {
            return null;
        }
        return QuotedMessage.resolve(replyToId, messages.findById(replyToId).orElse(null));
    }
}
