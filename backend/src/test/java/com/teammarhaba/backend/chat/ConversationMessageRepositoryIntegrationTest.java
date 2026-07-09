package com.teammarhaba.backend.chat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Verifies the {@code conversation} / {@code conversation_member} / {@code message} mappings and the
 * repository lookups against a real Postgres (Testcontainers) — the pieces the DB owns and an
 * H2/unit test could never prove: the partial-unique "one thread per event" index (and that
 * admin-broadcast rows with a null {@code event_id} are exempt), the {@code UNIQUE (conversation_id,
 * user_id)} membership pair, DB-authoritative {@code created_at} ordering of a thread timeline, the
 * moderation soft-delete filtering, and the {@code lastReadAt}-relative unread count (including the
 * "never read = everything unread" null-cursor case).
 *
 * <p>Deliberately <b>not</b> {@code @Transactional} at class level: each {@code save} runs in its
 * own transaction so every row gets its own DB-side {@code now()} (a shared test transaction would
 * stamp every row with one identical instant and defeat the ordering assertions). Every assertion is
 * scoped to the conversation/user created in that method, so rows other methods leave behind can't
 * interfere. Timestamps are always sourced by re-fetching through a finder (a fresh SELECT), never
 * off a {@code save()} return, since the DB-default columns are mapped {@code insertable = false}.
 */
class ConversationMessageRepositoryIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private ConversationRepository conversations;

    @Autowired
    private ConversationMemberRepository members;

    @Autowired
    private MessageRepository messages;

    @Autowired
    private UserRepository users;

    @Autowired
    private EventRepository events;

    @Autowired
    private JdbcTemplate jdbc;

    private Long newUser(String uid) {
        return users.save(new User(uid, uid + "@example.com", uid)).getId();
    }

    private Long newEvent(String heading) {
        Instant now = Instant.now();
        return events.save(new Event(
                        heading,
                        "A friendly meetup.",
                        "Marhaba Cafe, 12 High St",
                        "Europe/London",
                        now.plus(Duration.ofDays(7)),
                        now.minus(Duration.ofHours(1)),
                        now.plus(Duration.ofDays(30)),
                        newUser(heading + "-creator"),
                        now))
                .getId();
    }

    // ── conversation ─────────────────────────────────────────────────────────────────────────────

    @Test
    void anEventHasAtMostOneGroupThreadButBroadcastsAreExempt() {
        Long eventId = newEvent("one-thread");

        Conversation thread = conversations.save(Conversation.forEvent(eventId));
        assertThat(thread.getType()).isEqualTo(ConversationType.EVENT_GROUP);

        // The event resolves to its single thread — how the fan-out (TM-437) finds it.
        assertThat(conversations.findByEventId(eventId)).get().extracting(Conversation::getId).isEqualTo(thread.getId());
        assertThat(conversations.existsByEventId(eventId)).isTrue();

        // A second EVENT_GROUP for the same event is rejected by the partial-unique index.
        assertThatThrownBy(() -> conversations.saveAndFlush(Conversation.forEvent(eventId)))
                .isInstanceOf(DataIntegrityViolationException.class);

        // But admin broadcasts (event_id null) are exempt — many can coexist.
        conversations.save(Conversation.adminBroadcast());
        conversations.save(Conversation.adminBroadcast());
        // findByEventId ignores the null-event broadcasts and still returns just the group thread.
        assertThat(conversations.findByEventId(eventId)).get().extracting(Conversation::getId).isEqualTo(thread.getId());
    }

    @Test
    void adminBroadcastThreadHasNoEventAndCanBeSoftClosed() {
        Conversation broadcast = conversations.save(Conversation.adminBroadcast());
        assertThat(broadcast.getType()).isEqualTo(ConversationType.ADMIN_BROADCAST);
        assertThat(broadcast.getEventId()).isNull();
        assertThat(broadcast.isClosed()).isFalse();

        broadcast.close(Instant.now());
        conversations.save(broadcast);

        Conversation reloaded = conversations.findById(broadcast.getId()).orElseThrow();
        assertThat(reloaded.isClosed()).isTrue();
        assertThat(reloaded.getClosedAt()).isNotNull();
        assertThat(reloaded.getCreatedAt()).isNotNull(); // DB-authoritative default now()
    }

    // ── conversation_member ──────────────────────────────────────────────────────────────────────

    @Test
    void membershipIsUniquePerUserPerThreadAndListsForTheUser() {
        Conversation a = conversations.save(Conversation.adminBroadcast());
        Conversation b = conversations.save(Conversation.adminBroadcast());
        Long user = newUser("member-user");

        members.save(new ConversationMember(a.getId(), user, MemberRole.MEMBER));
        members.save(new ConversationMember(b.getId(), user, MemberRole.ADMIN));

        // Same (conversation, user) twice violates the UNIQUE pair.
        assertThatThrownBy(() ->
                        members.saveAndFlush(new ConversationMember(a.getId(), user, MemberRole.MEMBER)))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(members.existsByConversationIdAndUserId(a.getId(), user)).isTrue();

        // "Conversations for a user" — both threads the user belongs to, newest membership first.
        List<ConversationMember> mine = members.findByUserIdOrderByJoinedAtDesc(user);
        assertThat(mine).extracting(ConversationMember::getConversationId).containsExactly(b.getId(), a.getId());

        // The single-membership lookup (access check + read-cursor update point).
        assertThat(members.findByConversationIdAndUserId(a.getId(), user))
                .get()
                .extracting(ConversationMember::getRole)
                .isEqualTo(MemberRole.MEMBER);
    }

    @Test
    void rosterAndFanoutRecipientsRespectMuteState() {
        Conversation thread = conversations.save(Conversation.adminBroadcast());
        Long active = newUser("fanout-active");
        Long readOnly = newUser("fanout-readonly");
        Long removed = newUser("fanout-removed");

        members.save(new ConversationMember(thread.getId(), active, MemberRole.MEMBER));

        ConversationMember ro = new ConversationMember(thread.getId(), readOnly, MemberRole.MEMBER);
        ro.setMute(MuteState.READ_ONLY);
        members.save(ro);

        ConversationMember rm = new ConversationMember(thread.getId(), removed, MemberRole.MEMBER);
        rm.setMute(MuteState.REMOVED);
        members.save(rm);

        // Full roster = everyone, regardless of mute (the read API's member list).
        assertThat(members.findByConversationId(thread.getId()))
                .extracting(ConversationMember::getUserId)
                .containsExactlyInAnyOrder(active, readOnly, removed);

        // Fan-out recipient set = only the active (mute = NONE) members.
        assertThat(members.findByConversationIdAndMute(thread.getId(), MuteState.NONE))
                .extracting(ConversationMember::getUserId)
                .containsExactly(active);
    }

    @Test
    void membershipSurvivesAUserSoftDeleteAndPeopleResolveThroughUser() {
        Conversation thread = conversations.save(Conversation.adminBroadcast());
        Long user = newUser("tombstone-member");
        members.save(new ConversationMember(thread.getId(), user, MemberRole.MEMBER));

        // Account soft-delete is a tombstone, not a hard DELETE — the FK never fires.
        jdbc.update("update users set deleted_at = now() where id = ?", user);

        // The membership row survives (the roster/fan-out stay truthful)...
        assertThat(members.findByConversationIdAndUserId(thread.getId(), user)).isPresent();
        // ...but the person no longer resolves through the User aggregate — which is exactly why
        // callers must resolve people through UserRepository, never through this child table.
        assertThat(users.findById(user)).isEmpty();
    }

    // ── message ──────────────────────────────────────────────────────────────────────────────────

    @Test
    void timelineIsOrderedByDbAuthoritativeCreatedAtAndPagesBothWays() {
        Conversation thread = conversations.save(Conversation.adminBroadcast());
        Long author = newUser("timeline-author");

        // Each save is its own transaction, so each row gets its own DB-side now() — the order.
        messages.save(Message.fromUser(thread.getId(), author, "first"));
        messages.save(Message.fromSystem(thread.getId(), "system from TeamMarhaba", "/home"));
        messages.save(Message.fromUser(thread.getId(), author, "third"));

        // Newest-first list finder.
        List<Message> newestFirst =
                messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId());
        assertThat(newestFirst).extracting(Message::getBody).containsExactly("third", "system from TeamMarhaba", "first");
        assertThat(newestFirst).extracting(Message::getCreatedAt).isNotNull();

        // A system message carries a null sender ("from TeamMarhaba").
        Message system = newestFirst.get(1);
        assertThat(system.isSystem()).isTrue();
        assertThat(system.getSenderId()).isNull();
        assertThat(system.getDeepLink()).isEqualTo("/home");

        // Paged timeline, oldest-first (render order) — one finder, direction set by the Pageable.
        Sort oldestFirst = Sort.by("createdAt").ascending().and(Sort.by("id").ascending());
        assertThat(messages.findByConversationIdAndDeletedAtIsNull(thread.getId(), PageRequest.of(0, 2, oldestFirst)))
                .extracting(Message::getBody)
                .containsExactly("first", "system from TeamMarhaba");

        // Paged timeline, newest-first (page-down order).
        Sort newest = Sort.by("createdAt").descending().and(Sort.by("id").descending());
        assertThat(messages.findByConversationIdAndDeletedAtIsNull(thread.getId(), PageRequest.of(0, 1, newest)))
                .extracting(Message::getBody)
                .containsExactly("third");

        // Last-message preview for the thread list.
        assertThat(messages.findFirstByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId()))
                .get()
                .extracting(Message::getBody)
                .isEqualTo("third");
    }

    @Test
    void moderationSoftDeleteHidesAMessageFromEveryRead() {
        Conversation thread = conversations.save(Conversation.adminBroadcast());
        Long author = newUser("moderation-author");
        messages.save(Message.fromUser(thread.getId(), author, "keep me"));
        Message offensive = messages.save(Message.fromUser(thread.getId(), author, "remove me"));

        // An admin soft-deletes the offending message — the row is kept, deletedAt stamped.
        offensive.softDelete(Instant.now());
        messages.save(offensive);

        assertThat(messages.findById(offensive.getId())).get().extracting(Message::isDeleted).isEqualTo(true);
        // ...but it no longer surfaces in any timeline read.
        assertThat(messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId()))
                .extracting(Message::getBody)
                .containsExactly("keep me");
    }

    @Test
    void unreadCountIsRelativeToTheLastReadCursor() {
        Conversation thread = conversations.save(Conversation.adminBroadcast());
        Long reader = newUser("unread-reader");
        ConversationMember membership =
                members.save(new ConversationMember(thread.getId(), reader, MemberRole.MEMBER));

        messages.save(Message.fromUser(thread.getId(), newUser("unread-a"), "one"));
        messages.save(Message.fromUser(thread.getId(), newUser("unread-b"), "two"));
        messages.save(Message.fromUser(thread.getId(), newUser("unread-c"), "three"));

        // A never-read member (null cursor) has everything unread.
        assertThat(membership.getLastReadAt()).isNull();
        assertThat(messages.countUnread(thread.getId(), null)).isEqualTo(3);

        // Reading up to the newest message clears the unread count.
        List<Message> newestFirst =
                messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId());
        Instant newestAt = newestFirst.getFirst().getCreatedAt();
        membership.markRead(newestAt);
        members.save(membership);
        assertThat(messages.countUnread(thread.getId(), membership.getLastReadAt())).isZero();

        // A message posted after the cursor is unread again (its DB now() is after the cursor).
        messages.save(Message.fromUser(thread.getId(), newUser("unread-d"), "four"));
        assertThat(messages.countUnread(thread.getId(), newestAt)).isEqualTo(1);

        // Soft-deleted messages never count toward unread.
        Message four = messages.findFirstByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId())
                .orElseThrow();
        four.softDelete(Instant.now());
        messages.save(four);
        assertThat(messages.countUnread(thread.getId(), newestAt)).isZero();
    }

    @Test
    void markReadOnlyMovesTheCursorForward() {
        Conversation thread = conversations.save(Conversation.adminBroadcast());
        Long reader = newUser("cursor-reader");
        ConversationMember membership =
                members.save(new ConversationMember(thread.getId(), reader, MemberRole.MEMBER));

        // Truncate to millis so the stored TIMESTAMPTZ (microsecond precision) round-trips losslessly
        // on every platform — a raw nanosecond Instant.now() (Linux/CI) would not equal itself back.
        Instant later = Instant.now().truncatedTo(ChronoUnit.MILLIS);
        Instant earlier = later.minus(Duration.ofHours(1));

        membership.markRead(later);
        membership.markRead(earlier); // a stale/older read must not rewind the cursor
        members.save(membership);

        assertThat(members.findByConversationIdAndUserId(thread.getId(), reader))
                .get()
                .extracting(ConversationMember::getLastReadAt)
                .isEqualTo(later);
    }
}
