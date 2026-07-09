package com.teammarhaba.backend.chat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.api.EmojiReactionCount;
import com.teammarhaba.backend.api.MessageReactionSummary;
import com.teammarhaba.backend.api.ThreadMessageResponse;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.ConflictException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.security.access.AccessDeniedException;

/**
 * Verifies message reactions (TM-461) end-to-end against a real Postgres (Testcontainers) — the
 * toggle on/off, the duplicate guard the {@code UNIQUE (message_id, user_id, emoji)} constraint
 * enforces, the per-emoji counts + caller {@code mine} flag the thread projection carries, the member
 * gate (non-member / removed → 404, indistinguishable from a missing message — TM-576; read-only
 * allowed), the closed-thread freeze (→ 409), the
 * "like = default emoji" behaviour, and the {@code 404} for an unknown / moderation-removed message.
 *
 * <p>Deliberately <b>not</b> {@code @Transactional} at class level: each service call runs in its own
 * transaction so every reaction/message row gets its own DB-side {@code now()} — a shared test
 * transaction would stamp one identical instant and defeat the first-reacted chip ordering.
 */
class MessageReactionServiceIntegrationTest extends AbstractIntegrationTest {

    /** Newest-first page — enough to hold every message a test posts. */
    private static final PageRequest FIRST_PAGE =
            PageRequest.of(0, 50, Sort.by(Sort.Order.desc("createdAt"), Sort.Order.desc("id")));

    @Autowired
    private MessageReactionService service;

    @Autowired
    private MessageReactionRepository reactions;

    @Autowired
    private ConversationRepository conversations;

    @Autowired
    private ConversationMemberRepository members;

    @Autowired
    private MessageRepository messages;

    @Autowired
    private UserRepository users;

    // ── fixtures ─────────────────────────────────────────────────────────────────────────────────

    private Long newUser(String uid) {
        return users.save(new User(uid, uid + "@example.com", uid)).getId();
    }

    private VerifiedUser caller(String uid) {
        return new VerifiedUser(uid, uid + "@example.com");
    }

    /** A user provisioned AND joined to the thread with the given mute state — returns their VerifiedUser. */
    private VerifiedUser member(Long conversationId, String uid, MuteState mute) {
        Long userId = newUser(uid);
        ConversationMember m = new ConversationMember(conversationId, userId, MemberRole.MEMBER);
        m.setMute(mute);
        members.save(m);
        return caller(uid);
    }

    private Conversation openThread() {
        return conversations.save(Conversation.adminBroadcast());
    }

    private Long postMessage(Long conversationId, Long senderId, String body) {
        return messages.save(Message.fromUser(conversationId, senderId, body)).getId();
    }

    /** The reaction summary for one message as seen by a caller, read back through the thread projection. */
    private List<EmojiReactionCount> reactionsSeenBy(VerifiedUser caller, Long conversationId, Long messageId) {
        return service.threadMessages(caller, conversationId, FIRST_PAGE).items().stream()
                .filter(m -> m.id().equals(messageId))
                .findFirst()
                .map(ThreadMessageResponse::reactions)
                .orElseThrow();
    }

    // ── toggle on / off + duplicate guard ─────────────────────────────────────────────────────────

    @Test
    void reactTogglesOnThenOffAndIsIdempotent() {
        Conversation thread = openThread();
        VerifiedUser member = member(thread.getId(), "toggle-member", MuteState.NONE);
        Long message = postMessage(thread.getId(), newUser("toggle-author"), "hi");

        // Toggle ON with an explicit emoji → one reaction, counted, flagged as the caller's own.
        MessageReactionSummary on = service.react(member, message, "👍");
        assertThat(on.reactions()).containsExactly(new EmojiReactionCount("👍", 1, true));

        // Re-react the SAME emoji → idempotent no-op: still exactly one row (the duplicate guard).
        service.react(member, message, "👍");
        assertThat(reactions.findByMessageIdOrderByCreatedAtAscIdAsc(message)).hasSize(1);

        // Toggle OFF → the reaction is gone, summary empty.
        MessageReactionSummary off = service.unreact(member, message, "👍");
        assertThat(off.reactions()).isEmpty();
        assertThat(reactions.findByMessageIdOrderByCreatedAtAscIdAsc(message)).isEmpty();

        // Un-react again → harmless no-op (removing an absent reaction).
        assertThat(service.unreact(member, message, "👍").reactions()).isEmpty();
    }

    @Test
    void sameUserMayAddSeveralDifferentEmojisButNotDuplicateOne() {
        Conversation thread = openThread();
        VerifiedUser member = member(thread.getId(), "multi-member", MuteState.NONE);
        Long message = postMessage(thread.getId(), newUser("multi-author"), "hi");

        service.react(member, message, "👍");
        service.react(member, message, "👍"); // duplicate → still one 👍
        service.react(member, message, "🎉"); // a different emoji → a second, distinct reaction

        // Two distinct emojis for the one user, each count 1, both flagged as the caller's own.
        assertThat(service.react(member, message, "🎉").reactions()) // idempotent re-react to fetch summary
                .containsExactly(
                        new EmojiReactionCount("👍", 1, true),
                        new EmojiReactionCount("🎉", 1, true));
        assertThat(reactions.findByMessageIdOrderByCreatedAtAscIdAsc(message)).hasSize(2);
    }

    // ── per-emoji counts + caller-reacted flag, via the thread projection ─────────────────────────

    @Test
    void threadProjectionCarriesPerEmojiCountsAndCallerReactedFlag() {
        Conversation thread = openThread();
        VerifiedUser a = member(thread.getId(), "count-a", MuteState.NONE);
        VerifiedUser b = member(thread.getId(), "count-b", MuteState.NONE);
        VerifiedUser c = member(thread.getId(), "count-c", MuteState.NONE);
        Long message = postMessage(thread.getId(), newUser("count-author"), "poll");

        service.react(a, message, "👍"); // first-reacted emoji
        service.react(b, message, "👍");
        service.react(c, message, "❤️"); // second emoji, one reactor

        // Counts are per distinct emoji, in first-reacted order; 👍 has 2, ❤️ has 1.
        assertThat(reactionsSeenBy(a, thread.getId(), message))
                .containsExactly(
                        new EmojiReactionCount("👍", 2, true), // A reacted 👍 → mine=true
                        new EmojiReactionCount("❤️", 1, false)); // A did not react ❤️

        // The mine flag is per-caller: from C's view 👍 is not theirs but ❤️ is.
        assertThat(reactionsSeenBy(c, thread.getId(), message))
                .containsExactly(
                        new EmojiReactionCount("👍", 2, false),
                        new EmojiReactionCount("❤️", 1, true));
    }

    @Test
    void threadProjectionExcludesSoftDeletedMessagesButKeepsSystemMessages() {
        Conversation thread = openThread();
        VerifiedUser member = member(thread.getId(), "proj-member", MuteState.NONE);
        Long author = newUser("proj-author");

        Long kept = postMessage(thread.getId(), author, "keep me");
        messages.save(Message.fromSystem(thread.getId(), "from TeamMarhaba", "/home"));
        Message removed = messages.save(Message.fromUser(thread.getId(), author, "remove me"));
        removed.softDelete(Instant.now());
        messages.save(removed);
        service.react(member, kept, "👍");

        PageResponse<ThreadMessageResponse> page = service.threadMessages(member, thread.getId(), FIRST_PAGE);

        // The moderation-removed message never surfaces; the live user + system messages do.
        assertThat(page.items()).extracting(ThreadMessageResponse::body)
                .containsExactlyInAnyOrder("keep me", "from TeamMarhaba");
        // A system message carries a null sender; a message with no reactions has an empty summary.
        ThreadMessageResponse system = page.items().stream()
                .filter(m -> m.body().equals("from TeamMarhaba")).findFirst().orElseThrow();
        assertThat(system.senderId()).isNull();
        assertThat(system.reactions()).isEmpty();
    }

    // ── like = default emoji ──────────────────────────────────────────────────────────────────────

    @Test
    void likeIsTheDefaultEmojiThroughTheSameMechanism() {
        Conversation thread = openThread();
        VerifiedUser member = member(thread.getId(), "like-member", MuteState.NONE);
        Long message = postMessage(thread.getId(), newUser("like-author"), "nice");

        // A "like" = an emoji-less react (the client's double-tap) → resolves to the default glyph,
        // stored as an ordinary reaction row. Blank is treated the same as null.
        service.react(member, message, null);
        service.react(member, message, "  ");

        List<MessageReaction> rows = reactions.findByMessageIdOrderByCreatedAtAscIdAsc(message);
        assertThat(rows).hasSize(1); // null + blank both mean the one default like → no duplicate
        assertThat(rows.get(0).getEmoji()).isEqualTo(MessageReactionService.DEFAULT_EMOJI);
        assertThat(service.react(member, message, null).reactions())
                .containsExactly(new EmojiReactionCount(MessageReactionService.DEFAULT_EMOJI, 1, true));

        // Un-liking is un-reacting the default emoji (also emoji-less).
        assertThat(service.unreact(member, message, null).reactions()).isEmpty();
    }

    // ── member gate ───────────────────────────────────────────────────────────────────────────────

    @Test
    void reactByANonMemberOrRemovedMemberIs404NotForbidden() {
        Conversation thread = openThread();
        Long message = postMessage(thread.getId(), newUser("gate-author"), "hi");

        // A user who was never a member of the thread → 404, NOT 403. A 403 for a real message vs a
        // 404 for a missing one would leak message existence over sequential ids; collapsing the
        // non-member case to the same "message … not found" closes that oracle (TM-576).
        VerifiedUser stranger = caller("gate-stranger");
        newUser("gate-stranger");
        assertThatThrownBy(() -> service.react(stranger, message, "👍"))
                .isInstanceOf(ResourceNotFoundException.class)
                .hasMessageContaining("not found");
        assertThatThrownBy(() -> service.unreact(stranger, message, "👍"))
                .isInstanceOf(ResourceNotFoundException.class);

        // A REMOVED member (kicked) → also 404 (same reason), even though the membership row still exists.
        VerifiedUser removed = member(thread.getId(), "gate-removed", MuteState.REMOVED);
        assertThatThrownBy(() -> service.react(removed, message, "👍"))
                .isInstanceOf(ResourceNotFoundException.class);

        // A READ_ONLY member MAY react (the gate is "non-removed", and a reaction is not a post).
        VerifiedUser readOnly = member(thread.getId(), "gate-readonly", MuteState.READ_ONLY);
        assertThat(service.react(readOnly, message, "👍").reactions())
                .containsExactly(new EmojiReactionCount("👍", 1, true));

        // The read projection is member-gated separately — a non-member still cannot read the thread (403).
        assertThatThrownBy(() -> service.threadMessages(stranger, thread.getId(), FIRST_PAGE))
                .isInstanceOf(AccessDeniedException.class);
    }

    @Test
    void reactingOnAClosedThreadIsRejectedButHistoryStaysReadable() {
        Conversation thread = openThread();
        VerifiedUser member = member(thread.getId(), "closed-member", MuteState.NONE);
        Long message = postMessage(thread.getId(), newUser("closed-author"), "hi");
        service.react(member, message, "👍"); // react while still open

        thread.close(Instant.now());
        conversations.save(thread);

        // A closed thread freezes reactions → 409.
        assertThatThrownBy(() -> service.react(member, message, "🎉"))
                .isInstanceOf(ConflictException.class);
        assertThatThrownBy(() -> service.unreact(member, message, "👍"))
                .isInstanceOf(ConflictException.class);

        // ...but the closed thread (and its existing reactions) stays readable — soft-close, not delete.
        assertThat(reactionsSeenBy(member, thread.getId(), message))
                .containsExactly(new EmojiReactionCount("👍", 1, true));
    }

    // ── unknown / removed targets ─────────────────────────────────────────────────────────────────

    @Test
    void reactingToAnUnknownOrRemovedMessageIs404() {
        Conversation thread = openThread();
        VerifiedUser member = member(thread.getId(), "missing-member", MuteState.NONE);

        // No such message id.
        assertThatThrownBy(() -> service.react(member, 999_999L, "👍"))
                .isInstanceOf(ResourceNotFoundException.class);

        // A moderation-removed message is treated as absent (don't leak a hidden message's existence).
        Message removed = messages.save(Message.fromUser(thread.getId(), newUser("missing-author"), "gone"));
        removed.softDelete(Instant.now());
        messages.save(removed);
        assertThatThrownBy(() -> service.react(member, removed.getId(), "👍"))
                .isInstanceOf(ResourceNotFoundException.class);

        // An unknown thread on the read path is a 404.
        assertThatThrownBy(() -> service.threadMessages(member, 999_999L, FIRST_PAGE))
                .isInstanceOf(ResourceNotFoundException.class);
    }
}
