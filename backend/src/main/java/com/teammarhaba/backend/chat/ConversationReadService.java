package com.teammarhaba.backend.chat;

import com.teammarhaba.backend.api.ConversationMessageResponse;
import com.teammarhaba.backend.api.ConversationSummaryResponse;
import com.teammarhaba.backend.api.EmojiReactionCount;
import com.teammarhaba.backend.api.MarkReadResponse;
import com.teammarhaba.backend.api.MessageReadReceipt;
import com.teammarhaba.backend.api.QuotedMessage;
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

        // Which memberships surface in the list: a REMOVED (kicked) membership is excluded outright
        // (mirroring the read/mark-read access gate). A self-LEFT membership (TM-471) IS kept, but
        // flagged (see summary → `left`), so the list can render it as a de-emphasised "you left —
        // rejoin" row: that is where the AC's "rejoin affordance" lives, and it is the ONLY way a left
        // member can act on a thread they've hidden. A self-muted membership stays a normal row (the
        // member still sees the thread) and is flagged `notificationsMuted` so the row can show it.
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
     * The caller's aggregate unread across <em>every</em> thread they belong to (TM-582) — the single
     * number the Chat-tab badge (TM-439) paints.
     *
     * <p><b>Why a dedicated total, separate from {@link #list}.</b> {@code list} is paged for rendering,
     * so a client summing its per-thread {@code unreadCount} only ever saw the first page and undercounted
     * a caller with more than one page of threads. This sums over <em>all</em> the caller's non-removed
     * memberships, so the badge is accurate no matter how many threads they are in.
     *
     * <p>Deliberately far cheaper than {@code list}: it needs neither the thread rows, the event headings,
     * the last-message previews, nor the activity sort — only each membership's own unread. So it fetches
     * the same non-removed memberships (a {@link MuteState#REMOVED} / kicked membership contributes nothing,
     * mirroring the list + access gates) and folds each one's {@link MessageRepository#countUnread} — the
     * identical per-member count {@link #summary} computes — against that member's {@code lastReadAt}
     * cursor (a {@code null} cursor = never opened = every live message unread). Per-caller, so the same
     * threads yield a different total for two people; {@code 0} for a brand-new account with no memberships.
     */
    @Transactional(readOnly = true)
    public long unreadTotal(VerifiedUser caller) {
        Long userId = users.provision(caller).getId();
        return members.findByUserIdOrderByJoinedAtDesc(userId).stream()
                .filter(m -> m.getMute() != MuteState.REMOVED)
                .mapToLong(m -> messages.countUnread(m.getConversationId(), m.getLastReadAt()))
                .sum();
    }

    /**
     * A page of one thread's messages (TM-436), chronological (oldest→newest), members-only, each with
     * its reaction summary (TM-461), a read receipt when it's the caller's OWN message (TM-463), and —
     * for a reply — its quoted-parent snippet (TM-466). The {@code pageable} carries the window and the
     * chronological sort the controller fixes; the query filters {@code deletedAt IS NULL}, so
     * moderation-removed messages never surface. A non-member (or a removed member, or an unknown thread
     * id) is a {@code 403} — see {@link #requireMember}. This is the single thread-read endpoint:
     * reactions, read receipts AND reply quotes all ride the same page as the messages so the timeline
     * renders chips, receipts and quotes without a second round-trip, each resolved in its own batch (no
     * N+1) — see {@link #readReceipts} and the reply-quote batch below.
     *
     * <p><b>Reply quotes</b> are resolved in one batch (no N+1): collect the page's distinct reply-parent
     * ids, load those parents in a single {@code findAllById} (which — unlike the timeline query —
     * intentionally does NOT filter {@code deletedAt}, so a soft-deleted parent is still found and
     * rendered as "message unavailable" rather than silently dropped), then map each reply to its {@link
     * QuotedMessage}. A parent can sit outside this page (an older message), which is exactly why it's a
     * keyed lookup rather than a scan of the page's own rows.
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

        // Read receipts (TM-463) for the caller's OWN messages on this page — also one query for the
        // whole page (the thread roster), no N+1. Absent (null) for messages the caller didn't send.
        Map<Long, MessageReadReceipt> receipts = readReceipts(userId, conversationId, page.getContent());

        // Resolve the quoted parents for any replies on this page in ONE batch (TM-466). Parents are
        // fetched WITHOUT the deletedAt filter so a soft-deleted parent surfaces as "message unavailable"
        // (QuotedMessage.resolve), and a parent may live outside this page — hence a keyed load.
        Set<Long> parentIds = page.getContent().stream()
                .map(Message::getReplyToMessageId)
                .filter(java.util.Objects::nonNull)
                .collect(Collectors.toSet());
        Map<Long, Message> parents = parentIds.isEmpty()
                ? Map.of()
                : messages.findAllById(parentIds).stream().collect(Collectors.toMap(Message::getId, Function.identity()));

        // Every message carries: its reaction chips (TM-461), a read receipt if it's the caller's own
        // (TM-463, else null), and a quoted-parent snippet if it's a reply (TM-466, else null) — all
        // batch-resolved above, so the timeline renders with no N+1 and no second round-trip.
        return PageResponse.from(page, message -> ConversationMessageResponse.from(
                message,
                summaries.getOrDefault(message.getId(), List.of()),
                receipts.get(message.getId()),
                quotedParent(message, parents)));
    }

    /**
     * The quoted-parent snippet for one message (TM-466): {@code null} when it isn't a reply (so the
     * {@code parents} map — which is {@link Map#of()} on a page with no replies — is never keyed with a
     * {@code null}), otherwise resolved from the pre-loaded parent (or "unavailable" when it's gone).
     */
    private static QuotedMessage quotedParent(Message message, Map<Long, Message> parents) {
        Long replyToId = message.getReplyToMessageId();
        return replyToId == null ? null : QuotedMessage.resolve(replyToId, parents.get(replyToId));
    }

    /**
     * Read receipts (TM-463) for the caller's OWN messages on a page: for each message the caller sent,
     * how many <em>other</em> current members have read it, plus their ids (the "read by N → who" list).
     *
     * <p><b>Derived from the existing {@code last_read_at} cursors — no new table.</b> A member has read
     * a message when their forward-only read cursor (TM-436) is at/after the message's {@code created_at}.
     *
     * <p><b>Only the caller's own messages get a receipt</b> (privacy: only the sender sees read info on
     * their own message), so the map is keyed by those message ids alone; every other message resolves to
     * a {@code null} receipt on the wire. System messages ({@code null} sender) never match the caller, so
     * they're naturally excluded.
     *
     * <p><b>No N+1.</b> The thread roster is fetched <em>once</em> for the whole page; each own message's
     * readers are then found by scanning that in-memory roster (bounded by roster size × own-messages).
     *
     * <p><b>Group semantics (the AC).</b> Readers are the thread's current <em>non-removed</em> members
     * other than the sender ({@code count} reflects live membership — a kicked member drops out) who were
     * already in the thread when the message was posted, so a later joiner can't retro-change a past
     * message's count. See {@link #hasRead}.
     */
    private Map<Long, MessageReadReceipt> readReceipts(
            Long callerUserId, Long conversationId, List<Message> page) {
        List<Message> own = page.stream()
                .filter(message -> callerUserId.equals(message.getSenderId()))
                .toList();
        if (own.isEmpty()) {
            return Map.of();
        }
        // ONE query for the whole page's read state: the thread's roster, minus removed members and the
        // caller themselves (the sender is never a reader of their own message). A READ_ONLY member can
        // still read, so the gate is "not REMOVED", mirroring the read-access gate.
        List<ConversationMember> roster = members.findByConversationId(conversationId).stream()
                .filter(member -> member.getMute() != MuteState.REMOVED)
                .filter(member -> !callerUserId.equals(member.getUserId()))
                .toList();
        Map<Long, MessageReadReceipt> receipts = new java.util.LinkedHashMap<>();
        for (Message message : own) {
            List<Long> readerIds = roster.stream()
                    .filter(member -> hasRead(member, message.getCreatedAt()))
                    .map(ConversationMember::getUserId)
                    .sorted() // deterministic order for the "who read it" list
                    .toList();
            receipts.put(message.getId(), MessageReadReceipt.of(readerIds));
        }
        return receipts;
    }

    /**
     * Whether {@code member} counts as having read a message posted at {@code messageCreatedAt}. Two
     * conditions, both required:
     *
     * <ul>
     *   <li><b>Present when it was posted</b> — {@code joinedAt <= messageCreatedAt}. A member who joins
     *       later must not retro-change a past message's read count, even though their forward-only
     *       cursor (set to "now" the first time they open the thread) would otherwise sweep past it.
     *   <li><b>Cursor has reached it</b> — {@code lastReadAt >= messageCreatedAt}. A {@code null} cursor
     *       (never opened) has read nothing.
     * </ul>
     */
    private static boolean hasRead(ConversationMember member, Instant messageCreatedAt) {
        Instant joinedAt = member.getJoinedAt();
        Instant cursor = member.getLastReadAt();
        return joinedAt != null
                && !joinedAt.isAfter(messageCreatedAt)
                && cursor != null
                && !cursor.isBefore(messageCreatedAt);
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
     * Assert the caller is an active member of the thread, or throw a {@code 403} — the shared access
     * gate reused by the live-chat SSE subscription (TM-464). Resolves the reader from the verified
     * principal (never a client id) and applies the same visibility rule as {@link #messages} / {@link
     * #markRead}, so a non-member, a kicked member, a self-left member and an unknown/foreign thread are
     * indistinguishable ({@code 403}) — the live stream can't be used to probe thread ids. Read-only so
     * it never opens a write transaction just to gate a subscription.
     *
     * @throws AccessDeniedException {@code 403} if the caller is not an active member of the thread
     */
    @Transactional(readOnly = true)
    public void assertMember(VerifiedUser caller, Long conversationId) {
        Long userId = users.provision(caller).getId();
        requireMember(conversationId, userId);
    }

    /**
     * The caller's readable membership of the thread, or a {@code 403}. A member may read only while
     * the thread is <em>visible</em> to them — {@link MuteState#NONE} (including a self-muted member,
     * whose mute only silences push) or {@link MuteState#READ_ONLY}. Absent membership, a {@link
     * MuteState#REMOVED} (kicked) membership and a {@link MuteState#LEFT} (self-left, TM-471) membership
     * are all treated identically — and identically to an unknown thread — so thread existence can't be
     * probed across accounts, and a member who left must rejoin (which un-hides the thread) before they
     * can read it again.
     */
    private ConversationMember requireMember(Long conversationId, Long userId) {
        return members.findByConversationIdAndUserId(conversationId, userId)
                .filter(m -> m.getMute() == MuteState.NONE || m.getMute() == MuteState.READ_ONLY)
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
        // Carry the caller's own self-service membership state (TM-471) so the list can render the right
        // control: `notificationsMuted` → show a muted indicator; `left` → render a rejoin row.
        return ConversationSummaryResponse.of(
                thread,
                title(thread, eventHeadingsById),
                lastMessage,
                unread,
                lastActiveAt,
                member.isNotificationsMuted(),
                member.hasLeft());
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
