package com.teammarhaba.backend.chat;

import com.teammarhaba.backend.api.ConversationMessageResponse;
import com.teammarhaba.backend.api.ConversationSummaryResponse;
import com.teammarhaba.backend.api.EmojiReactionCount;
import com.teammarhaba.backend.api.MarkReadResponse;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.UserService;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Reads the caller's chat over the TM-435 conversation model — the service behind the {@code
 * /api/v1} conversation read API (TM-436). It sits directly on the shared thread store ({@link
 * ConversationRepository} / {@link ConversationMemberRepository} / {@link MessageRepository}) that
 * both event group chat (TM-433) and admin broadcasts (TM-432) persist into, so the app's single
 * "chat" section reads every thread out of one place.
 *
 * <p><b>Identity is always the verified caller.</b> Every method resolves the reader from the {@link
 * VerifiedUser} principal via {@link UserService#provision} — the same just-in-time provisioning the
 * rest of the {@code /me} surface uses (a brand-new account simply has no memberships) — never from a
 * client-supplied id, so a caller can only ever read their own chat.
 *
 * <p><b>Membership is the access gate.</b> {@link #messages} and {@link #markRead} require the caller
 * to be an active member of the thread: no membership row (or a {@link MuteState#REMOVED} one — a
 * kicked member) is a {@code 403} via {@link AccessDeniedException} (mapped to RFC 7807 by the global
 * handler). We deliberately return {@code 403} rather than {@code 404} for an unknown/foreign thread
 * so a caller can't probe which conversation ids exist. A {@link MuteState#READ_ONLY} member may
 * still read (that state only stops posting), so the gate is "membership present and not REMOVED".
 *
 * <p><b>Unread</b> everywhere is {@link MessageRepository#countUnread}: live messages created after
 * the member's {@code last_read_at} cursor (a {@code null} cursor = never opened = everything unread).
 * It is per-member, so the same thread carries a different unread count for two people.
 */
@Service
public class ConversationReadService {

    private final ConversationRepository conversations;
    private final ConversationMemberRepository members;
    private final MessageRepository messages;
    private final EventRepository events;
    private final UserService users;
    private final MessageReactionService reactionSummaries;

    public ConversationReadService(
            ConversationRepository conversations,
            ConversationMemberRepository members,
            MessageRepository messages,
            EventRepository events,
            UserService users,
            MessageReactionService reactionSummaries) {
        this.conversations = conversations;
        this.members = members;
        this.messages = messages;
        this.events = events;
        this.users = users;
        this.reactionSummaries = reactionSummaries;
    }

    /**
     * The caller's conversation list (TM-436) — one {@link ConversationSummaryResponse} per thread
     * they belong to, most-recently-active first, paged.
     *
     * <p>Assembled in memory over the caller's memberships (bounded by how many threads a person is
     * in — a handful of event chats plus the broadcast channel, not an unbounded feed), because the
     * sort key ("last activity") is derived from each thread's newest message rather than a stored
     * column: fetch the non-removed memberships, resolve their threads (and, for event chats, the
     * event heading for the derived title) in bulk, compute each thread's last-message preview +
     * per-member unread count, sort by last-activity descending (thread id as the deterministic
     * same-instant tiebreak), then window to the requested page. Totals span every membership so the
     * client's pager is accurate.
     */
    @Transactional(readOnly = true)
    public PageResponse<ConversationSummaryResponse> list(VerifiedUser caller, Pageable pageable) {
        Long userId = users.provision(caller).getId();

        // Only threads the caller can actually read: a REMOVED (kicked) membership is excluded from
        // their list, mirroring the access gate on the thread + mark-read routes.
        List<ConversationMember> memberships = members.findByUserIdOrderByJoinedAtDesc(userId).stream()
                .filter(m -> m.getMute() != MuteState.REMOVED)
                .toList();

        // Bulk-resolve the threads (one query) and the event headings for the derived titles (one
        // query), so title/preview assembly below doesn't re-hit those tables per row.
        Map<Long, Conversation> threadsById = conversations
                .findAllById(memberships.stream()
                        .map(ConversationMember::getConversationId)
                        .collect(Collectors.toSet()))
                .stream()
                .collect(Collectors.toMap(Conversation::getId, Function.identity()));
        Map<Long, String> eventHeadingsById = eventHeadings(threadsById.values());

        List<ConversationSummaryResponse> rows = memberships.stream()
                .map(m -> summary(m, threadsById.get(m.getConversationId()), eventHeadingsById))
                .filter(java.util.Objects::nonNull)
                // Most-recently-active first; thread id descending breaks a same-instant tie.
                .sorted(Comparator.comparing(ConversationSummaryResponse::lastActiveAt)
                        .thenComparing(ConversationSummaryResponse::id)
                        .reversed())
                .toList();

        return window(rows, pageable);
    }

    /**
     * A page of one thread's messages (TM-436), chronological (oldest→newest), members-only, each with
     * its reaction summary (TM-461). The {@code pageable} carries the window and the chronological sort
     * the controller fixes; the query filters {@code deletedAt IS NULL}, so moderation-removed messages
     * never surface. A non-member (or a removed member, or an unknown thread id) is a {@code 403} — see
     * {@link #requireMember}. This is the single thread-read endpoint: reactions ride the same page as
     * the messages so the timeline renders chips without a second round-trip.
     */
    @Transactional(readOnly = true)
    public PageResponse<ConversationMessageResponse> messages(
            VerifiedUser caller, Long conversationId, Pageable pageable) {
        Long userId = users.provision(caller).getId();
        requireMember(conversationId, userId);

        Page<Message> page = messages.findByConversationIdAndDeletedAtIsNull(conversationId, pageable);
        // Attach each message's reaction summary (TM-461) so the timeline renders chips inline — one
        // batched query for the page (no N+1), reusing the reaction service's shared summariser.
        Map<Long, List<EmojiReactionCount>> summaries =
                reactionSummaries.summariesFor(userId, page.getContent().stream().map(Message::getId).toList());
        return PageResponse.from(page, message -> ConversationMessageResponse.from(
                message, summaries.getOrDefault(message.getId(), List.of())));
    }

    /**
     * Mark the thread read for the caller (TM-436): advance their {@code last_read_at} cursor
     * (forward-only via {@link ConversationMember#markRead}, so a stale re-read never rewinds it) and
     * return the fresh cursor + recomputed unread count. Members-only — a non-member is a {@code 403}.
     *
     * <p><b>The cursor is stamped from a DB-sourced instant, never the app clock (TM-580).</b> {@link
     * MessageRepository#countUnread} counts live messages whose DB-authoritative {@code created_at}
     * ({@code DEFAULT now()}) is strictly after the cursor, so cursor and message timestamps must
     * share one clock. Stamping from {@link Instant#now()} (the app clock) meant that under app/DB
     * clock skew a message the caller has just seen — created at a DB instant slightly ahead of the
     * app clock — still satisfied {@code created_at > last_read_at} and stayed counted unread, so
     * {@code unreadCount} could be non-zero right after mark-read. We anchor the cursor to the newest
     * live message's {@code created_at}: that is precisely the value {@code countUnread} compares
     * against, so no already-posted message can read as unread here. A silent thread (no live message)
     * has nothing unread regardless, and falls back to the DB's own {@code now()} so the cursor still
     * advances on the same clock any later message will be timestamped by.
     */
    @Transactional
    public MarkReadResponse markRead(VerifiedUser caller, Long conversationId) {
        Long userId = users.provision(caller).getId();
        ConversationMember member = requireMember(conversationId, userId);

        Instant readCursor = messages
                .findFirstByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(conversationId)
                .map(Message::getCreatedAt)
                .orElseGet(messages::databaseNow);

        member.markRead(readCursor); // forward-only, idempotent; dirty-checking flushes on commit
        members.save(member);

        long unread = messages.countUnread(conversationId, member.getLastReadAt());
        return new MarkReadResponse(conversationId, member.getLastReadAt(), unread);
    }

    /**
     * The caller's active membership of the thread, or a {@code 403}. Absent membership and a {@link
     * MuteState#REMOVED} (kicked) membership are treated identically — and identically to an unknown
     * thread — so thread existence can't be probed across accounts.
     */
    private ConversationMember requireMember(Long conversationId, Long userId) {
        return members.findByConversationIdAndUserId(conversationId, userId)
                .filter(m -> m.getMute() != MuteState.REMOVED)
                .orElseThrow(() -> new AccessDeniedException("Not a member of this conversation."));
    }

    /** Build one list row for a membership; {@code null} (skipped by the caller) if its thread vanished. */
    private ConversationSummaryResponse summary(
            ConversationMember member, Conversation thread, Map<Long, String> eventHeadingsById) {
        if (thread == null) {
            return null; // defensive: a membership whose thread row is gone is simply omitted
        }
        Message lastMessage = messages
                .findFirstByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId())
                .orElse(null);
        // Last activity = the newest live message's instant, or the thread's own creation while silent.
        Instant lastActiveAt = lastMessage != null ? lastMessage.getCreatedAt() : thread.getCreatedAt();
        long unread = messages.countUnread(thread.getId(), member.getLastReadAt());
        return ConversationSummaryResponse.of(
                thread, title(thread, eventHeadingsById), lastMessage, unread, lastActiveAt);
    }

    /**
     * Bulk-resolve the headings of the events behind the {@code EVENT_GROUP} threads, so titles can be
     * derived without a per-row event lookup. Soft-deleted events are invisible to {@code
     * EventRepository} (its {@code @SQLRestriction}), so they simply don't appear here and their
     * thread falls back to the generic title.
     */
    private Map<Long, String> eventHeadings(java.util.Collection<Conversation> threads) {
        Set<Long> eventIds = threads.stream()
                .map(Conversation::getEventId)
                .filter(java.util.Objects::nonNull)
                .collect(Collectors.toSet());
        if (eventIds.isEmpty()) {
            return Map.of();
        }
        return events.findAllById(eventIds).stream()
                .collect(Collectors.toMap(Event::getId, Event::getHeading));
    }

    /**
     * The thread's derived, display-ready title: an {@code EVENT_GROUP} borrows its event heading
     * (falling back to a generic label when the event is missing/soft-deleted), an {@code
     * ADMIN_BROADCAST} is the fixed "from TeamMarhaba" title.
     */
    private String title(Conversation thread, Map<Long, String> eventHeadingsById) {
        return switch (thread.getType()) {
            case EVENT_GROUP -> eventHeadingsById.getOrDefault(
                    thread.getEventId(), ConversationSummaryResponse.EVENT_GROUP_FALLBACK_TITLE);
            case ADMIN_BROADCAST -> ConversationSummaryResponse.ADMIN_BROADCAST_TITLE;
        };
    }

    /**
     * Window an already-sorted list into a {@link PageResponse} matching the {@code pageable}'s page
     * number and (clamped) size — the in-memory equivalent of a Spring Data {@code Page}, with totals
     * spanning the whole list so the client's pager is accurate.
     */
    private static PageResponse<ConversationSummaryResponse> window(
            List<ConversationSummaryResponse> rows, Pageable pageable) {
        int size = pageable.getPageSize();
        int page = pageable.getPageNumber();
        int total = rows.size();
        // Compute the window bounds in long space and clamp into [0, total] before narrowing back to
        // int. A large page (e.g. ?page=999999999) makes page * size overflow a 32-bit int to a
        // negative value, which would drive subList(from, ...) out of range and 500 the request; the
        // long math + clamp instead yields an empty page (from == to == total) — a valid 200 for any
        // page past the end, including a caller with zero conversations.
        int from = (int) Math.min((long) page * size, total);
        int to = (int) Math.min((long) from + size, total);
        int totalPages = (int) Math.ceil((double) total / size);
        return new PageResponse<>(rows.subList(from, to), page, size, total, totalPages);
    }
}
