package com.teammarhaba.backend.chat;

import com.teammarhaba.backend.api.ConversationMessageResponse;
import com.teammarhaba.backend.api.MessageReadReceipt;
import com.teammarhaba.backend.api.QuotedMessage;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.EventChatLifecycleService;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.BadRequestException;
import com.teammarhaba.backend.web.ConflictException;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The event-chat write path (TM-447, epic Event Chat wave-2): an attendee posting a message to their
 * event's group thread. This is the write sibling of the live thread read
 * ({@link ConversationReadService#messages}) and the first consumer of the whole chat foundation's
 * write seam:
 *
 * <ul>
 *   <li>the shared message store (TM-435) — persists a {@link Message};</li>
 *   <li>the thread-lifecycle / close policy (TM-446) — rejects a post to a closed thread via
 *       {@link EventChatLifecycleService#isThreadReadOnly}, which it <em>consumes</em> rather than
 *       re-deriving the close window here;</li>
 *   <li>the push fan-out hook (TM-437) — so every other active member hears about the message without
 *       the app open (the offline / store-and-forward path). This service no longer calls the notifier
 *       in-line; it publishes a {@link MessageCreatedEvent} which {@link MessageCreatedPushListener}
 *       consumes <em>after commit</em> (TM-579), so a rolled-back post never pushes and the FCM call
 *       never holds the write connection.</li>
 *   <li>the live transport hook (TM-464) — the same {@link MessageCreatedEvent} is consumed
 *       <em>after commit</em> by {@link MessageCreatedStreamListener}, which broadcasts the created
 *       message over {@link ChatStreamService#broadcast} to every member currently connected to the
 *       thread's SSE stream, so an open app renders it instantly (the live-while-online path). Firing
 *       it off the same post-commit event (rather than in-line) means a rolled-back post broadcasts
 *       nothing live either, exactly like the push.</li>
 * </ul>
 *
 * <p><b>Identity is always the verified caller.</b> The acting member is resolved from the
 * {@link VerifiedUser} principal via {@link UserService#provision} (the same just-in-time
 * provisioning the rest of the {@code /me} surface uses), never from a client-supplied id — so a
 * caller can only ever post as themselves.
 *
 * <p><b>The gate (per the AC), in order:</b>
 * <ol>
 *   <li>the caller must be an active member whose {@link MuteState} is {@link MuteState#NONE NONE} — a
 *       non-member, a {@link MuteState#REMOVED REMOVED} (kicked) member, a
 *       {@link MuteState#READ_ONLY READ_ONLY} (muted) member, <em>and an unknown / foreign thread</em>
 *       (which simply has no membership row) are all a uniform {@code 403}
 *       ({@link AccessDeniedException}), so a POST can't probe which thread ids exist — matching the
 *       read gate ({@link ConversationReadService#messages}) rather than leaking existence with a
 *       {@code 404} (TM-573). Posting is stricter than reacting: reactions allow a {@code READ_ONLY}
 *       member (a read-side signal), but the AC gates posting on "non-removed,
 *       <em>non-read-only-muted</em>", so anything but an active member is denied;</li>
 *   <li>the thread must be open → a closed / read-only thread the caller <em>is</em> a member of is
 *       {@code 409} ({@link ConflictException}). For an event thread this is TM-446's
 *       {@link EventChatLifecycleService#isThreadReadOnly} (manually soft-closed, or past its policy
 *       close time); a soft-deleted event has no live chat, so it too reads as closed.</li>
 * </ol>
 *
 * <p><b>Body length</b> is bounded at the edge by Bean Validation on {@code PostMessageRequest}
 * (≤ {@code 500}); this service takes the already-validated text.
 *
 * <p><b>Ordering.</b> In the write transaction: persist the message (flushed so the DB-authoritative
 * {@code createdAt} reads straight back), record one {@link AuditAction#EVENT_CHAT_MESSAGE_POSTED}
 * audit row, then <em>publish</em> a {@link MessageCreatedEvent}. Neither fan-out is run here — the
 * push ({@link MessageCreatedPushListener}) and the live SSE broadcast
 * ({@link MessageCreatedStreamListener}) both fire {@code AFTER_COMMIT} (TM-579 / TM-464). Publishing
 * rather than pushing/broadcasting in-line is what makes both fan-outs honour the "after commit"
 * contract: if the commit fails after the message row was written, neither listener runs, so no
 * recipient is pushed <em>and</em> no connected member is broadcast to about a rolled-back message; and
 * because both run post-commit they no longer hold the write connection open across their network calls.
 */
@Service
public class MessagePostService {

    private final UserService users;
    private final ConversationRepository conversations;
    private final ConversationMemberRepository members;
    private final MessageRepository messages;
    private final EventRepository events;
    private final EventChatLifecycleService lifecycle;
    private final ApplicationEventPublisher publisher;
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
            ApplicationEventPublisher publisher,
            AuditService audit) {
        this(users, conversations, members, messages, events, lifecycle, publisher, audit, Clock.systemUTC());
    }

    /** Test-visible constructor: inject a fixed {@link Clock} to drive the close-policy time deterministically. */
    MessagePostService(
            UserService users,
            ConversationRepository conversations,
            ConversationMemberRepository members,
            MessageRepository messages,
            EventRepository events,
            EventChatLifecycleService lifecycle,
            ApplicationEventPublisher publisher,
            AuditService audit,
            Clock clock) {
        this.users = users;
        this.conversations = conversations;
        this.members = members;
        this.messages = messages;
        this.events = events;
        this.lifecycle = lifecycle;
        this.publisher = publisher;
        this.audit = audit;
        this.clock = clock;
    }

    /**
     * Post {@code body} to thread {@code conversationId} as the verified caller, optionally as a REPLY
     * quoting {@code replyToMessageId} (TM-466). Applies the member + open-thread gate, validates the
     * reply target (when present), persists the message, audits the post, and publishes the
     * {@link MessageCreatedEvent} that fires the push + live-SSE fan-outs after commit. Returns the
     * created message as the read DTO — with an empty reaction summary (a brand-new message has none
     * yet), an empty read receipt (TM-463: as the caller's OWN message, "read by 0" the instant it's
     * created), and the quoted-parent snippet when it's a reply — so the client can append it to the
     * timeline optimistically, receipt and quote and all.
     *
     * @param replyToMessageId the message being replied to, or {@code null} for a plain message. When
     *     non-null it must name a live message in THIS thread, else a {@code 400} (below) — the reply
     *     target is checked AFTER the member/open gate, so it can't be used to probe other threads.
     * @throws AccessDeniedException {@code 403} if the caller is not an active (NONE) member — this
     *     includes an unknown / foreign thread (no membership row), so thread existence isn't leaked
     * @throws ConflictException     {@code 409} if the thread is closed / read-only
     * @throws BadRequestException   {@code 400} if {@code replyToMessageId} names a message that isn't a
     *     live message of this thread (missing, moderation-removed, or in another conversation)
     */
    @Transactional
    public ConversationMessageResponse post(
            VerifiedUser caller, Long conversationId, String body, Long replyToMessageId) {
        Long userId = users.provision(caller).getId();

        // Membership gate FIRST (TM-573): an unknown thread has no membership row and falls through to
        // the same 403 as a non-member / REMOVED member, so a POST can't probe which thread ids exist —
        // mirroring the read gate (ConversationReadService.requireMember) rather than leaking existence
        // with a 404.
        requireActiveMember(conversationId, userId);

        // The caller is an active member, so the thread exists; load it for the close-policy check. A
        // membership row with no surviving thread ("shouldn't happen") stays uniform at 403 rather than
        // 500-ing or re-introducing an existence leak.
        Conversation conversation = conversations
                .findById(conversationId)
                .orElseThrow(() -> new AccessDeniedException("You are not a member of this thread."));

        requireOpenThread(conversation);

        // Reply target check (TM-466), only reached by an active member of an open thread: the parent
        // must be a live message OF THIS conversation. A missing / soft-deleted / foreign target is a
        // uniform 400 (below), so a reply can't be used to probe which message ids exist elsewhere.
        Message parent = requireReplyTarget(conversationId, replyToMessageId);

        // Persist, flushing so the @Generated DB-authoritative created_at is read straight back for the
        // DTO. A reply carries its parent id; a plain message doesn't.
        Message saved = messages.saveAndFlush(
                replyToMessageId == null
                        ? Message.fromUser(conversationId, userId, body)
                        : Message.replyFromUser(conversationId, userId, body, replyToMessageId));

        // Audit the post (the durable text lives in the message row; the audit only names it).
        audit.record(
                caller.uid(),
                AuditAction.EVENT_CHAT_MESSAGE_POSTED,
                TARGET_CONVERSATION,
                conversationId.toString(),
                Map.of("messageId", saved.getId()));

        // Announce the message in-transaction; both fan-outs consume this AFTER_COMMIT:
        //   • MessageCreatedPushListener fans the TM-437 push out to OTHER active members (offline path);
        //   • MessageCreatedStreamListener broadcasts it over SSE to members CONNECTED to this thread's
        //     stream (TM-464, the live-while-online path).
        // Publishing (rather than pushing/broadcasting in-line) means a rolled-back post fires NEITHER, so
        // nobody is ever notified — by push or live — about a message that then disappears (TM-579).
        publisher.publishEvent(new MessageCreatedEvent(saved));

        // A freshly posted message carries no reactions yet, and — as the caller's OWN message — an
        // empty read receipt (TM-463): nobody else could have read it in the instant since it was
        // created, so the sender immediately sees it as "sent, read by 0". We ALSO echo the
        // quoted-parent snippet (TM-466) so the optimistic client render shows the quote immediately
        // (the parent is already loaded + validated above). This is the exact DTO the poster gets back;
        // the live-broadcast payload is rebuilt in the stream listener from the same message (with a null
        // receipt + null quote — a broadcast is caller-independent and re-syncs over the read API), so
        // the poster's own optimistic echo is the richest view and nothing diverges lossily.
        return ConversationMessageResponse.from(
                saved, List.of(), MessageReadReceipt.empty(), QuotedMessage.resolve(replyToMessageId, parent));
    }

    /**
     * Validate an optional reply target (TM-466): {@code null} (a plain message) resolves to {@code
     * null}; otherwise the id must name a still-live message that belongs to {@code conversationId}.
     * A missing, moderation-removed, or foreign (other-thread) target is a uniform {@code 400} with a
     * generic reason, so a reply can't probe which message ids exist in threads the caller can't read.
     * Returns the resolved parent so the caller can build the echo's quoted snippet without re-loading.
     */
    private Message requireReplyTarget(Long conversationId, Long replyToMessageId) {
        if (replyToMessageId == null) {
            return null;
        }
        return messages
                .findById(replyToMessageId)
                .filter(parent -> !parent.isDeleted() && parent.getConversationId().equals(conversationId))
                .orElseThrow(() -> new BadRequestException(
                        "The message you're replying to isn't available in this thread."));
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
                /* active member — allowed to post. A self-muted member (TM-471) is still NONE and may
                 * post: self-mute only silences their inbound push, it never gags them. */
            }
            case READ_ONLY -> throw new AccessDeniedException("You are muted in this thread and cannot post.");
            // A self-left member (TM-471) has hidden/exited the thread — like a non-member/removed one they
            // get the uniform "not a member" 403 (they must rejoin before they can post again).
            case LEFT, REMOVED -> throw new AccessDeniedException("You are not a member of this thread.");
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
