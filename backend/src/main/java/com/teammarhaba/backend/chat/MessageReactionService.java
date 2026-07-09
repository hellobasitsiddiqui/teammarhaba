package com.teammarhaba.backend.chat;

import com.teammarhaba.backend.api.EmojiReactionCount;
import com.teammarhaba.backend.api.MessageReactionSummary;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.EventChatLifecycleService;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.ConflictException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Clock;
import java.time.Instant;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Message reactions (TM-461) — the light-touch "react without replying" interaction on top of the
 * shared message store (TM-435). Owns the react / un-react toggle and the per-message reaction
 * summary the conversation read projection carries.
 *
 * <p><b>Identity is always the verified caller.</b> Every entry point resolves the acting member from
 * the {@link VerifiedUser} principal via {@link UserService#provision} (the same just-in-time
 * provisioning the rest of the {@code /me} surface uses), never from a client-supplied id — so a
 * caller can only ever react as themselves and only ever see their own {@code mine} flags.
 *
 * <p><b>Member gate (per the AC), unified with the not-found path.</b> To react or un-react, the
 * caller must be a <em>non-removed</em> member of the message's thread and the thread must be
 * <em>open</em>:
 * <ul>
 *   <li>an unknown or moderation-removed message — <em>and equally</em> a caller who is not a
 *       non-removed member of the message's thread — is the same {@code 404}
 *       ({@link ResourceNotFoundException}). Collapsing the non-member case onto the not-found case
 *       (TM-576) closes an existence oracle: over these message-scoped endpoints a caller must not be
 *       able to tell a real message they simply can't see (once {@code 403}) apart from one that never
 *       existed ({@code 404}) by walking sequential message ids;
 *   <li>the thread is closed → {@code 409} ({@link ConflictException}) — reactions are frozen with the
 *       rest of the thread, but history (including existing reactions) stays readable. For an {@code
 *       EVENT_GROUP} thread "closed" is TM-446's {@link EventChatLifecycleService#isThreadReadOnly}
 *       (manually soft-closed <em>or</em> past the per-event close-time policy), mirroring the post
 *       path (TM-574) so a reaction and a post freeze on exactly the same window; a non-event
 *       (admin-broadcast) thread has no close policy and falls back to the plain soft-close flag.
 * </ul>
 * A {@link MuteState#READ_ONLY} member <em>may</em> react: the gate is "non-removed", and a reaction
 * is a read-side signal, not a posted message.
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
    private final EventRepository events;
    private final EventChatLifecycleService lifecycle;
    private final UserService users;
    private final Clock clock;

    /** Spring-wired constructor — real wall clock. */
    @Autowired
    public MessageReactionService(
            MessageReactionRepository reactions,
            MessageRepository messages,
            ConversationRepository conversations,
            ConversationMemberRepository members,
            EventRepository events,
            EventChatLifecycleService lifecycle,
            UserService users) {
        this(reactions, messages, conversations, members, events, lifecycle, users, Clock.systemUTC());
    }

    /**
     * Test-visible constructor: inject a fixed {@link Clock} so the event close-policy branch of {@link
     * #requireOpenThread} can be driven deterministically (mirrors {@code MessagePostService}).
     */
    MessageReactionService(
            MessageReactionRepository reactions,
            MessageRepository messages,
            ConversationRepository conversations,
            ConversationMemberRepository members,
            EventRepository events,
            EventChatLifecycleService lifecycle,
            UserService users,
            Clock clock) {
        this.reactions = reactions;
        this.messages = messages;
        this.conversations = conversations;
        this.members = members;
        this.events = events;
        this.lifecycle = lifecycle;
        this.users = users;
        this.clock = clock;
    }

    /**
     * Toggle-on: add the caller's reaction to a message (idempotent — a repeat react with the same
     * emoji is a no-op thanks to the unique guard). {@code emoji} null/blank → {@link #DEFAULT_EMOJI}
     * (a like). Returns the message's refreshed reaction summary.
     */
    @Transactional
    public MessageReactionSummary react(VerifiedUser caller, Long messageId, String emoji) {
        Long userId = users.provision(caller).getId();
        Long conversationId = requireReactableMessageThread(messageId, userId);
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
        Long conversationId = requireReactableMessageThread(messageId, userId);
        requireOpenThread(conversationId);

        reactions.deleteByMessageIdAndUserIdAndEmoji(messageId, userId, normalise(emoji));
        return summaryFor(messageId, userId);
    }

    /**
     * Reaction summaries for a page of messages, keyed by message id, from {@code callerUserId}'s
     * perspective (the per-emoji "did the caller react" flag). Loaded in one query for the whole page
     * (no N+1); a message with no reactions is simply absent from the map. Shared by the conversation
     * read endpoint (TM-436, the live thread read after the TM-436/447 consolidation) and this
     * service's own single-message {@link #summaryFor}, so every surface tallies reactions from one
     * place.
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

    /**
     * The member gate for the message-scoped reaction endpoints, folded into the not-found path
     * (TM-576). Resolve the live message's thread (a {@code 404} for an absent / moderation-removed
     * message via {@link #requireLiveMessageThread}), then require the caller to be a non-removed
     * member of that thread — and if they are <em>not</em>, raise the <em>identical</em> {@code 404}
     * ("message … not found") a missing message returns rather than a {@code 403}. That makes a real
     * message the caller can't see indistinguishable from one that never existed, so these endpoints
     * can't be walked as an existence oracle over sequential message ids. A genuine non-removed member
     * (including {@link MuteState#READ_ONLY}) gets the thread id back.
     */
    private Long requireReactableMessageThread(Long messageId, Long userId) {
        Long conversationId = requireLiveMessageThread(messageId);
        boolean nonRemovedMember = members.findByConversationIdAndUserId(conversationId, userId)
                .map(member -> member.getMute() != MuteState.REMOVED)
                .orElse(false);
        if (!nonRemovedMember) {
            throw new ResourceNotFoundException("message " + messageId + " not found");
        }
        return conversationId;
    }

    /**
     * Reactions may only change while the thread is open; a frozen thread is a {@code 409}. This
     * mirrors the post path ({@code MessagePostService}) exactly (TM-574): for an {@code EVENT_GROUP}
     * thread it resolves the backing event and gates on TM-446's {@link
     * EventChatLifecycleService#isThreadReadOnly} — the single resolver of "manually soft-closed, or
     * past the per-event close-time policy" — so a reaction and a post freeze on the same window (a
     * soft-deleted / missing event has no live chat and reads as closed). A non-event (admin-broadcast)
     * thread has no close policy, so it falls back to the plain {@link Conversation#isClosed()} flag.
     */
    private void requireOpenThread(Long conversationId) {
        Conversation conversation = conversations.findById(conversationId).orElse(null);
        if (conversation == null) {
            return; // the message resolved, so its thread exists; be defensive anyway.
        }
        Long eventId = conversation.getEventId();
        boolean closed;
        if (eventId != null) {
            Instant now = clock.instant();
            closed = events.findById(eventId)
                    .map(event -> lifecycle.isThreadReadOnly(event, now))
                    .orElse(true); // soft-deleted / missing event → no live chat
        } else {
            closed = conversation.isClosed();
        }
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
