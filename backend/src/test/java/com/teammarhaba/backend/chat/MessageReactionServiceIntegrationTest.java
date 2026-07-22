package com.teammarhaba.backend.chat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.api.EmojiReactionCount;
import com.teammarhaba.backend.api.MessageReactionSummary;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.BadRequestException;
import com.teammarhaba.backend.web.ConflictException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * Verifies message reactions (TM-461) end-to-end against a real Postgres (Testcontainers) — the
 * toggle on/off, the duplicate guard the {@code UNIQUE (message_id, user_id, emoji)} constraint
 * enforces, the per-emoji counts + caller {@code mine} flag the reaction summary carries, the member
 * gate (a non-member / removed member is a 404 — indistinguishable from a missing message, TM-576;
 * a read-only member is allowed), the closed-thread freeze (→ 409, including an event thread past its
 * close-policy window — TM-574, mirroring the post path), the "like = default emoji" behaviour, and
 * the {@code 404} for an unknown / moderation-removed message.
 *
 * <p>Deliberately <b>not</b> {@code @Transactional} at class level: each service call runs in its own
 * transaction so every reaction/message row gets its own DB-side {@code now()} — a shared test
 * transaction would stamp one identical instant and defeat the first-reacted chip ordering.
 */
class MessageReactionServiceIntegrationTest extends AbstractIntegrationTest {

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
    private EventRepository events;

    @Autowired
    private UserRepository users;

    // ── fixtures ─────────────────────────────────────────────────────────────────────────────────

    private Long newUser(String uid) {
        return users.save(new User(uid, uid + "@example.com", uid)).getId();
    }

    private VerifiedUser caller(String uid) {
        return new VerifiedUser(uid, uid + "@example.com");
    }

    /** The provisioned {@code users.id} behind a {@link VerifiedUser} — the key {@code summariesFor} takes. */
    private Long userIdOf(VerifiedUser caller) {
        return users.findByFirebaseUid(caller.uid()).orElseThrow().getId();
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

    /** An open-ended, never-close event (chat-close hours unset → app default "never close"); returns its id. */
    private Long newOpenEvent(String heading) {
        Instant now = Instant.now();
        return events.save(new Event(
                        heading,
                        "A friendly meetup.",
                        "Marhaba Cafe, 12 High St",
                        "Europe/London",
                        now.plus(Duration.ofDays(7)),
                        now.minus(Duration.ofHours(1)),
                        now.plus(Duration.ofDays(30)),
                        newUser(heading + "-host"),
                        now))
                .getId();
    }

    /** An event that ended {@code endedAgo} ago and auto-closes its chat {@code closeHours} after end. */
    private Long newEventEndedWithCloseWindow(String heading, Duration endedAgo, int closeHours) {
        Instant now = Instant.now();
        Event event = new Event(
                heading,
                "A finished meetup.",
                "Marhaba Cafe, 12 High St",
                "Europe/London",
                now.minus(endedAgo).minus(Duration.ofHours(2)), // started before it ended
                now.minus(Duration.ofDays(1)),
                now.plus(Duration.ofDays(30)),
                newUser(heading + "-host"),
                now);
        event.setEndAt(now.minus(endedAgo));
        event.setChatCloseHours(closeHours);
        return events.save(event).getId();
    }

    /** The reaction summary for one message as seen by a caller, read back through the shared summariser. */
    private List<EmojiReactionCount> reactionsSeenBy(VerifiedUser caller, Long messageId) {
        return service.summariesFor(userIdOf(caller), List.of(messageId)).getOrDefault(messageId, List.of());
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

    // ── per-emoji counts + caller-reacted flag, via the shared reaction summariser ────────────────

    @Test
    void reactionSummaryCarriesPerEmojiCountsAndCallerReactedFlag() {
        Conversation thread = openThread();
        VerifiedUser a = member(thread.getId(), "count-a", MuteState.NONE);
        VerifiedUser b = member(thread.getId(), "count-b", MuteState.NONE);
        VerifiedUser c = member(thread.getId(), "count-c", MuteState.NONE);
        Long message = postMessage(thread.getId(), newUser("count-author"), "poll");

        service.react(a, message, "👍"); // first-reacted emoji
        service.react(b, message, "👍");
        service.react(c, message, "❤️"); // second emoji, one reactor

        // Counts are per distinct emoji, in first-reacted order; 👍 has 2, ❤️ has 1.
        assertThat(reactionsSeenBy(a, message))
                .containsExactly(
                        new EmojiReactionCount("👍", 2, true), // A reacted 👍 → mine=true
                        new EmojiReactionCount("❤️", 1, false)); // A did not react ❤️

        // The mine flag is per-caller: from C's view 👍 is not theirs but ❤️ is.
        assertThat(reactionsSeenBy(c, message))
                .containsExactly(
                        new EmojiReactionCount("👍", 2, false),
                        new EmojiReactionCount("❤️", 1, true));
    }

    @Test
    void summariesForBatchesReactionsPerMessageAndOmitsMessagesWithNone() {
        Conversation thread = openThread();
        VerifiedUser member = member(thread.getId(), "batch-member", MuteState.NONE);
        Long author = newUser("batch-author");

        Long reacted = postMessage(thread.getId(), author, "react to me");
        Long silent = postMessage(thread.getId(), author, "nothing here");
        service.react(member, reacted, "👍");

        // One query for the whole batch: the reacted message carries its summary; a message with no
        // reactions is simply absent from the map (the read projection then defaults it to an empty
        // list). This is the surviving reaction-summary coverage after the thread-messages read moved
        // to ConversationReadService (TM-436/447 consolidation, TM-577).
        Map<Long, List<EmojiReactionCount>> summaries =
                service.summariesFor(userIdOf(member), List.of(reacted, silent));
        assertThat(summaries.get(reacted)).containsExactly(new EmojiReactionCount("👍", 1, true));
        assertThat(summaries).doesNotContainKey(silent);
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

    // ── member gate: non-member / removed collapse to 404 (TM-576) ────────────────────────────────

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
    }

    // ── closed-thread freeze (409) ────────────────────────────────────────────────────────────────

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
        assertThat(reactionsSeenBy(member, message))
                .containsExactly(new EmojiReactionCount("👍", 1, true));
    }

    @Test
    void reactingOnAnEventThreadPastItsClosePolicyWindowIs409ButAnOpenOneIs200() {
        // An open-ended, never-close event: its thread accepts reactions (200).
        Long openEventId = newOpenEvent("react-open");
        Conversation openThread = conversations.save(Conversation.forEvent(openEventId));
        VerifiedUser openMember = member(openThread.getId(), "react-open-member", MuteState.NONE);
        Long openMessage = postMessage(openThread.getId(), newUser("react-open-author"), "hi");
        assertThat(service.react(openMember, openMessage, "👍").reactions())
                .containsExactly(new EmojiReactionCount("👍", 1, true));

        // An event that ended an hour ago with a 0-hour close window is read-only BY POLICY (never
        // manually soft-closed). Reactions must freeze with 409 — the same close-policy gate the post
        // path uses (TM-574), so a reaction and a post agree on when an event thread is frozen. The
        // plain isClosed() flag alone (the old behaviour) would have let this through.
        Long closedEventId = newEventEndedWithCloseWindow("react-closed", Duration.ofHours(1), 0);
        Conversation closedThread = conversations.save(Conversation.forEvent(closedEventId));
        VerifiedUser closedMember = member(closedThread.getId(), "react-closed-member", MuteState.NONE);
        Long closedMessage = postMessage(closedThread.getId(), newUser("react-closed-author"), "hi");
        assertThatThrownBy(() -> service.react(closedMember, closedMessage, "🎉"))
                .isInstanceOf(ConflictException.class);
        assertThatThrownBy(() -> service.unreact(closedMember, closedMessage, "👍"))
                .isInstanceOf(ConflictException.class);
    }

    // ── emoji allow-list + per-user-per-message cap (TM-989) ───────────────────────────────────────

    @Test
    void reactingWithADisallowedEmojiIsRejected() {
        Conversation thread = openThread();
        VerifiedUser member = member(thread.getId(), "allowlist-member", MuteState.NONE);
        Long message = postMessage(thread.getId(), newUser("allowlist-author"), "hi");

        // An emoji outside the canonical picker set (TM-989 allow-list) must be rejected on the add
        // path — a member can't persist arbitrary <=32-char strings that every reader's UI would render
        // as reaction pills (text-spoofing / storage bloat). Length-bounded-only used to accept these.
        assertThatThrownBy(() -> service.react(member, message, "spoofed text"))
                .isInstanceOf(BadRequestException.class);
        assertThatThrownBy(() -> service.react(member, message, "🤬")) // a real emoji, but not in the set
                .isInstanceOf(BadRequestException.class);

        // ...and nothing was persisted for the rejected reactions.
        assertThat(reactions.findByMessageIdOrderByCreatedAtAscIdAsc(message)).isEmpty();
    }

    @Test
    void reactingWithAnAllowedEmojiStillSucceeds() {
        Conversation thread = openThread();
        VerifiedUser member = member(thread.getId(), "allowed-member", MuteState.NONE);
        Long message = postMessage(thread.getId(), newUser("allowed-author"), "hi");

        // Every glyph in the allow-list (including the default like ❤️) is accepted.
        for (String emoji : List.of("👍", "❤️", "😂", "🎉", "🙌")) {
            assertThat(service.react(member, message, emoji).reactions())
                    .anySatisfy(count -> assertThat(count.emoji()).isEqualTo(emoji));
        }
        assertThat(reactions.findByMessageIdOrderByCreatedAtAscIdAsc(message)).hasSize(5);
    }

    @Test
    void perUserPerMessageDistinctReactionCapIsEnforced() {
        Conversation thread = openThread();
        VerifiedUser member = member(thread.getId(), "cap-member", MuteState.NONE);
        Long message = postMessage(thread.getId(), newUser("cap-author"), "hi");

        // Fill the cap: one of each allowed emoji (the cap == allow-list size).
        for (String emoji : List.of("👍", "❤️", "😂", "🎉", "🙌")) {
            service.react(member, message, emoji);
        }
        assertThat(reactions.findByMessageIdOrderByCreatedAtAscIdAsc(message)).hasSize(5);

        // An idempotent re-react of an already-held emoji is still fine at the cap (adds no row).
        assertThat(service.react(member, message, "👍").reactions()).hasSize(5);

        // There is no 6th distinct allowed emoji to exceed the cap with a valid glyph, so drive the
        // cap directly by seeding a 6th DISTINCT legacy row, then a further distinct allowed react is a
        // 400. This proves the cap fires independently of (before adding) a new row.
        reactions.saveAndFlush(MessageReaction.of(message, userIdOf(member), "🙈")); // legacy 6th distinct
        assertThatThrownBy(() -> service.react(member, message, "😮")) // would be a 7th distinct → over cap
                .isInstanceOf(BadRequestException.class);
    }

    @Test
    void unreactOfADisallowedLegacyValueStillWorks() {
        Conversation thread = openThread();
        VerifiedUser member = member(thread.getId(), "legacy-member", MuteState.NONE);
        Long message = postMessage(thread.getId(), newUser("legacy-author"), "hi");

        // A value that predates the allow-list (persisted directly, as a legacy row would be) must
        // still be removable — the allow-list gates the ADD path only, never un-react.
        reactions.saveAndFlush(MessageReaction.of(message, userIdOf(member), "legacy-emoji"));
        assertThat(reactions.findByMessageIdOrderByCreatedAtAscIdAsc(message)).hasSize(1);

        assertThat(service.unreact(member, message, "legacy-emoji").reactions()).isEmpty();
        assertThat(reactions.findByMessageIdOrderByCreatedAtAscIdAsc(message)).isEmpty();
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
    }
}
