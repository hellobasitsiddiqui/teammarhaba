package com.teammarhaba.backend.chat;

import com.teammarhaba.backend.api.EmojiReactionCount;
import com.teammarhaba.backend.api.MessageReactionSummary;
import com.teammarhaba.backend.api.ThreadMessageResponse;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.ConflictException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Message reactions (TM-461) — the light-touch "react without replying" interaction on top of the
 * shared message store (TM-435). Owns the react / un-react toggle and the per-message reaction
 * summary the thread-messages read projection carries.
 *
 * <p><b>Identity is always the verified caller.</b> Every entry point resolves the acting member from
 * the {@link VerifiedUser} principal via {@link UserService#provision} (the same just-in-time
 * provisioning the rest of the {@code /me} surface uses), never from a client-supplied id — so a
 * caller can only ever react as themselves and only ever see their own {@code mine} flags.
 *
 * <p><b>Member gate (per the AC).</b> To react or un-react, the caller must be a <em>non-removed</em>
 * member of the message's thread and the thread must be <em>open</em>:
 * <ul>
 *   <li>not a member, or a {@link MuteState#REMOVED} member → {@code 403} ({@link AccessDeniedException});
 *   <li>the thread is soft-closed → {@code 409} ({@link ConflictException}) — reactions are frozen with
 *       the rest of the thread, but history (including existing reactions) stays readable;
 *   <li>an unknown or moderation-removed message → {@code 404} ({@link ResourceNotFoundException}), so a
 *       probe can't tell a hidden message from one that never existed.
 * </ul>
 * A {@link MuteState#READ_ONLY} member <em>may</em> react: the AC gates on "non-removed", and a
 * reaction is a read-side signal, not a posted message.
 *
 * <p><b>"Like" is not special.</b> When the caller omits the emoji it defaults to {@link #DEFAULT_EMOJI}
 * — so a client double-tap ("like") is a default-emoji react through this exact path, with no separate
 * like table or endpoint.
 */
@Service
public class MessageReactionService {

    /**
     * The default reaction glyph — what a "like" (an emoji-less react, e.g. the client's double-tap)
     * resolves to. A like is just this emoji through the normal react mechanism.
     */
    public static final String DEFAULT_EMOJI = "❤️"; // ❤️ (heart + emoji variation selector)

    private final MessageReactionRepository reactions;
    private final MessageRepository messages;
    private final ConversationRepository conversations;
    private final ConversationMemberRepository members;
    private final UserService users;

    public MessageReactionService(
            MessageReactionRepository reactions,
            MessageRepository messages,
            ConversationRepository conversations,
            ConversationMemberRepository members,
            UserService users) {
        this.reactions = reactions;
        this.messages = messages;
        this.conversations = conversations;
        this.members = members;
        this.users = users;
    }

    /**
     * Toggle-on: add the caller's reaction to a message (idempotent — a repeat react with the same
     * emoji is a no-op thanks to the unique guard). {@code emoji} null/blank → {@link #DEFAULT_EMOJI}
     * (a like). Returns the message's refreshed reaction summary.
     */
    @Transactional
    public MessageReactionSummary react(VerifiedUser caller, Long messageId, String emoji) {
        Long userId = users.provision(caller).getId();
        Long conversationId = requireLiveMessageThread(messageId);
        requireNonRemovedMember(conversationId, userId);
        requireOpenThread(conversationId);

        String glyph = normalise(emoji);
        // Toggle-on is idempotent: skip the insert if the reaction already exists, and if a concurrent
        // request beats us to it the UNIQUE (message_id, user_id, emoji) constraint holds — we swallow
        // that as "already reacted" so a double-tap never surfaces a 409.
        if (!reactions.existsByMessageIdAndUserIdAndEmoji(messageId, userId, glyph)) {
            try {
                reactions.saveAndFlush(MessageReaction.of(messageId, userId, glyph));
            } catch (DataIntegrityViolationException alreadyReacted) {
                // lost the race — the row exists now, which is exactly the desired end state.
            }
        }
        return summaryFor(messageId, userId);
    }

    /**
     * Toggle-off: remove the caller's reaction with this emoji from a message (idempotent — removing a
     * reaction that isn't there is a harmless no-op). {@code emoji} null/blank → {@link #DEFAULT_EMOJI}
     * (un-like). Returns the message's refreshed reaction summary.
     */
    @Transactional
    public MessageReactionSummary unreact(VerifiedUser caller, Long messageId, String emoji) {
        Long userId = users.provision(caller).getId();
        Long conversationId = requireLiveMessageThread(messageId);
        requireNonRemovedMember(conversationId, userId);
        requireOpenThread(conversationId);

        reactions.deleteByMessageIdAndUserIdAndEmoji(messageId, userId, normalise(emoji));
        return summaryFor(messageId, userId);
    }

    /**
     * The thread-messages read projection (the F2 / C2 read path) — a page of a thread's live messages,
     * newest-first, each carrying its reaction summary (emoji → count, plus whether the caller reacted).
     * Member-gated: the caller must be a non-removed member of the thread (a closed thread is still
     * readable — history stays visible). Reactions for the whole page are loaded in one query (no N+1).
     */
    @Transactional
    public PageResponse<ThreadMessageResponse> threadMessages(
            VerifiedUser caller, Long conversationId, Pageable pageable) {
        Long userId = users.provision(caller).getId();
        // 404 if the thread doesn't exist (before the membership check, so a probe can't distinguish a
        // thread they're not in from one that isn't there — both are indistinguishable to a non-member).
        if (!conversations.existsById(conversationId)) {
            throw new ResourceNotFoundException("conversation " + conversationId + " not found");
        }
        requireNonRemovedMember(conversationId, userId);

        Page<Message> page = messages.findByConversationIdAndDeletedAtIsNull(conversationId, pageable);
        Map<Long, List<EmojiReactionCount>> summaries =
                summariesFor(userId, page.getContent().stream().map(Message::getId).toList());

        return PageResponse.from(page, message -> ThreadMessageResponse.from(
                message, summaries.getOrDefault(message.getId(), List.of())));
    }

    /**
     * Reaction summaries for a page of messages, keyed by message id, from {@code callerUserId}'s
     * perspective (the per-emoji "did the caller react" flag). Loaded in one query for the whole page
     * (no N+1); a message with no reactions is simply absent from the map. Shared by this service's own
     * {@link #threadMessages} and the conversation read endpoint (TM-436), so both surface reactions
     * from one place.
     */
    @Transactional(readOnly = true)
    public Map<Long, List<EmojiReactionCount>> summariesFor(Long callerUserId, Collection<Long> messageIds) {
        Map<Long, List<MessageReaction>> byMessage = reactionsByMessage(messageIds);
        Map<Long, List<EmojiReactionCount>> out = new LinkedHashMap<>();
        byMessage.forEach((messageId, rows) -> out.put(messageId, summarise(rows, callerUserId)));
        return out;
    }

    // ── internals ──────────────────────────────────────────────────────────────────────────────────

    /**
     * Resolve a live (non-soft-deleted) message to its thread id, or {@code 404}. A moderation-removed
     * message is treated as absent so a probe can't tell a hidden message from a non-existent one.
     */
    private Long requireLiveMessageThread(Long messageId) {
        return messages.findById(messageId)
                .filter(message -> !message.isDeleted())
                .map(Message::getConversationId)
                .orElseThrow(() -> new ResourceNotFoundException("message " + messageId + " not found"));
    }

    /** The AC member gate: the caller must be a member of the thread and not {@link MuteState#REMOVED}. */
    private void requireNonRemovedMember(Long conversationId, Long userId) {
        MuteState mute = members.findByConversationIdAndUserId(conversationId, userId)
                .map(ConversationMember::getMute)
                .orElseThrow(() -> new AccessDeniedException("You are not a member of this thread."));
        if (mute == MuteState.REMOVED) {
            throw new AccessDeniedException("You are not a member of this thread.");
        }
    }

    /** Reactions may only change while the thread is open; a soft-closed thread is frozen ({@code 409}). */
    private void requireOpenThread(Long conversationId) {
        boolean closed = conversations.findById(conversationId)
                .map(Conversation::isClosed)
                .orElse(false); // the message resolved, so its thread exists; be defensive anyway.
        if (closed) {
            throw new ConflictException("This thread is closed; reactions can no longer be changed.");
        }
    }

    /** A single message's reaction summary from the caller's perspective. */
    private MessageReactionSummary summaryFor(Long messageId, Long callerUserId) {
        List<MessageReaction> rows = reactions.findByMessageIdOrderByCreatedAtAscIdAsc(messageId);
        return new MessageReactionSummary(messageId, summarise(rows, callerUserId));
    }

    /**
     * Collapse a message's reaction rows into one {@link EmojiReactionCount} per distinct emoji —
     * count of reactors, plus whether {@code callerUserId} is among them — preserving first-reacted
     * order (the rows arrive oldest-first, and {@link LinkedHashMap} keeps that encounter order).
     */
    private List<EmojiReactionCount> summarise(List<MessageReaction> rows, Long callerUserId) {
        // value = [count, mineFlag] accumulator, keyed by emoji in first-seen (oldest-reacted) order.
        Map<String, long[]> byEmoji = new LinkedHashMap<>();
        for (MessageReaction row : rows) {
            long[] agg = byEmoji.computeIfAbsent(row.getEmoji(), key -> new long[2]);
            agg[0]++;
            if (callerUserId != null && callerUserId.equals(row.getUserId())) {
                agg[1] = 1;
            }
        }
        return byEmoji.entrySet().stream()
                .map(entry -> new EmojiReactionCount(entry.getKey(), entry.getValue()[0], entry.getValue()[1] == 1))
                .toList();
    }

    /** Batched summaries for a page of messages: one query, grouped by message id (avoids N+1). */
    private Map<Long, List<MessageReaction>> reactionsByMessage(Collection<Long> messageIds) {
        if (messageIds.isEmpty()) {
            return Map.of();
        }
        return reactions.findByMessageIdInOrderByCreatedAtAscIdAsc(messageIds).stream()
                .collect(Collectors.groupingBy(
                        MessageReaction::getMessageId, LinkedHashMap::new, Collectors.toList()));
    }

    /** Empty/blank emoji (an emoji-less "like") resolves to the default glyph; otherwise trim-normalise. */
    private static String normalise(String emoji) {
        return (emoji == null || emoji.isBlank()) ? DEFAULT_EMOJI : emoji.trim();
    }
}
