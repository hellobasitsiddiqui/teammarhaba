package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.chat.Conversation;
import com.teammarhaba.backend.chat.ConversationMember;
import com.teammarhaba.backend.chat.ConversationMemberRepository;
import com.teammarhaba.backend.chat.ConversationRepository;
import com.teammarhaba.backend.chat.ConversationType;
import com.teammarhaba.backend.chat.MemberRole;
import com.teammarhaba.backend.chat.Message;
import com.teammarhaba.backend.chat.MessageRepository;
import com.teammarhaba.backend.chat.MuteState;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The event group-chat lifecycle (TM-446) end-to-end against real Postgres (Testcontainers), driven
 * through the real {@link EventRsvpService} hook so the whole path — the capacity-locked RSVP, the
 * lazy thread creation, the membership sync, and the DB's own cascade — is exercised exactly as in
 * production. Covers the ticket's test list: creation on first GOING, host is always an ADMIN member,
 * join/leave sync (and that the host is never removed), the waitlist-in-chat toggle (off by default,
 * on tracks conversion/leave), the close-policy soft-close making a thread read-only (with the
 * default "never close"), and the cascade-delete of a thread + members + messages when the event row
 * is hard-removed.
 *
 * <p>Deliberately <b>not</b> {@code @Transactional}: each RSVP command commits in its own
 * transaction (as production), so DB-authoritative timestamps and the {@code ON DELETE CASCADE}
 * behaviour are real. Every user is namespaced ({@link #ns}) so this suite can't collide with sibling
 * suites on the shared container, and cleanup removes only this test's rows.
 */
class EventChatLifecycleIntegrationTest extends AbstractIntegrationTest {

    @Autowired private EventRsvpService rsvps;
    @Autowired private EventChatLifecycleService lifecycle;
    @Autowired private EventRepository events;
    @Autowired private ConversationRepository conversations;
    @Autowired private ConversationMemberRepository members;
    @Autowired private MessageRepository messages;
    @Autowired private UserRepository users;
    @Autowired private JdbcTemplate jdbc;

    /** Per-test firebase_uid namespace so fixtures can't collide with sibling suites (as TM-419). */
    private final String ns = "chatlc-" + UUID.randomUUID().toString().substring(0, 8) + "-";

    @AfterEach
    void leaveNoResidue() {
        // Child-first, namespace-scoped cleanup: remove only this test's rows, never a DB-wide wipe.
        jdbc.update(
                "DELETE FROM message WHERE conversation_id IN (SELECT c.id FROM conversation c JOIN events e"
                        + " ON c.event_id = e.id WHERE e.created_by IN (SELECT id FROM users WHERE firebase_uid LIKE ?))",
                ns + "%");
        jdbc.update(
                "DELETE FROM conversation_member WHERE conversation_id IN (SELECT c.id FROM conversation c JOIN events e"
                        + " ON c.event_id = e.id WHERE e.created_by IN (SELECT id FROM users WHERE firebase_uid LIKE ?))",
                ns + "%");
        jdbc.update(
                "DELETE FROM conversation WHERE event_id IN (SELECT id FROM events WHERE created_by IN"
                        + " (SELECT id FROM users WHERE firebase_uid LIKE ?))",
                ns + "%");
        jdbc.update(
                "DELETE FROM event_attendance WHERE user_id IN (SELECT id FROM users WHERE firebase_uid LIKE ?)",
                ns + "%");
        jdbc.update(
                "DELETE FROM events WHERE created_by IN (SELECT id FROM users WHERE firebase_uid LIKE ?)", ns + "%");
        jdbc.update("DELETE FROM users WHERE firebase_uid LIKE ?", ns + "%");
    }

    // ── creation + host membership ───────────────────────────────────────────────────────────────

    @Test
    void firstGoingRsvpCreatesTheThreadWithTheHostAsAdminAndJoinsTheMember() {
        long host = newUser("host");
        Event event = seedEvent(host, 5, false, null);
        long attendee = newUser("attendee");

        // No RSVP yet → no thread.
        assertThat(conversations.findByEventId(event.getId())).isEmpty();

        rsvps.rsvp(caller(attendee), event.getId());

        Conversation thread = conversations.findByEventId(event.getId()).orElseThrow();
        assertThat(thread.getType()).isEqualTo(ConversationType.EVENT_GROUP);
        // Host is always a member, as ADMIN (AC: "host / admin are always members").
        assertThat(membership(thread, host)).extracting(ConversationMember::getRole).isEqualTo(MemberRole.ADMIN);
        assertThat(membership(thread, host).isActive()).isTrue();
        // The GOING attendee joined as an active MEMBER.
        assertThat(membership(thread, attendee).getRole()).isEqualTo(MemberRole.MEMBER);
        assertThat(membership(thread, attendee).isActive()).isTrue();
    }

    // ── join / leave sync ────────────────────────────────────────────────────────────────────────

    @Test
    void unRsvpRemovesTheMemberFromTheThreadButNeverTheHost() {
        long host = newUser("host");
        Event event = seedEvent(host, 5, false, null);
        long attendee = newUser("attendee");

        rsvps.rsvp(caller(host), event.getId()); // host also attends their own event
        rsvps.rsvp(caller(attendee), event.getId());
        Conversation thread = conversations.findByEventId(event.getId()).orElseThrow();
        assertThat(membership(thread, attendee).isActive()).isTrue();

        // Attendee leaves → removed from the thread (row kept as REMOVED).
        rsvps.cancelRsvp(caller(attendee), event.getId());
        assertThat(membership(thread, attendee).getMute()).isEqualTo(MuteState.REMOVED);

        // Host leaves their own event → still a member (host is always a member).
        rsvps.cancelRsvp(caller(host), event.getId());
        assertThat(membership(thread, host).isActive()).as("host stays a member after leaving").isTrue();
        assertThat(membership(thread, host).getRole()).isEqualTo(MemberRole.ADMIN);
    }

    @Test
    void rejoiningReactivatesTheSameMembershipRow() {
        long host = newUser("host");
        Event event = seedEvent(host, 5, false, null);
        long attendee = newUser("attendee");

        rsvps.rsvp(caller(attendee), event.getId());
        rsvps.cancelRsvp(caller(attendee), event.getId());
        rsvps.rsvp(caller(attendee), event.getId()); // rejoin

        Conversation thread = conversations.findByEventId(event.getId()).orElseThrow();
        // Exactly one membership row for the attendee (reactivated, not duplicated), active again.
        assertThat(members.findByConversationId(thread.getId()))
                .filteredOn(m -> m.getUserId().equals(attendee))
                .hasSize(1);
        assertThat(membership(thread, attendee).isActive()).isTrue();
    }

    // ── waitlist-in-chat toggle ──────────────────────────────────────────────────────────────────

    @Test
    void waitlistedMemberIsNotInChatWhenTheFlagIsOff() {
        long host = newUser("host");
        Event event = seedEvent(host, 1, false, null); // capacity 1, waitlist-in-chat OFF (default)
        long going = newUser("going");
        long waitlisted = newUser("waitlisted");

        rsvps.rsvp(caller(going), event.getId()); // fills the one spot, creates the thread
        RsvpResult result = rsvps.rsvp(caller(waitlisted), event.getId());
        assertThat(result.state()).isEqualTo(AttendanceState.WAITLISTED);

        Conversation thread = conversations.findByEventId(event.getId()).orElseThrow();
        assertThat(members.findByConversationIdAndUserId(thread.getId(), waitlisted))
                .as("waitlisted user is not a chat member while the flag is off")
                .isEmpty();
    }

    @Test
    void waitlistedMemberJoinsWhenTheFlagIsOnAndTracksConversionAndLeave() {
        long host = newUser("host");
        Event event = seedEvent(host, 1, true, null); // capacity 1, waitlist-in-chat ON
        long going = newUser("going");
        long waitlisted = newUser("waitlisted");

        rsvps.rsvp(caller(going), event.getId()); // fills the spot + creates the thread
        rsvps.rsvp(caller(waitlisted), event.getId()); // WAITLISTED — but joins chat (flag on)
        Conversation thread = conversations.findByEventId(event.getId()).orElseThrow();
        assertThat(membership(thread, waitlisted).isActive()).as("waitlisted joins chat when flag on").isTrue();

        // The GOING member leaves, freeing the spot; the waitlisted member claims it (→ GOING).
        rsvps.cancelRsvp(caller(going), event.getId());
        assertThat(membership(thread, going).getMute()).isEqualTo(MuteState.REMOVED); // left the event → left chat
        rsvps.claim(caller(waitlisted), event.getId());

        assertThat(attendanceState(event.getId(), waitlisted)).isEqualTo(AttendanceState.GOING);
        assertThat(membership(thread, waitlisted).isActive()).as("stays a member after converting to GOING").isTrue();

        // ...and leaving after converting removes them.
        rsvps.cancelRsvp(caller(waitlisted), event.getId());
        assertThat(membership(thread, waitlisted).getMute()).isEqualTo(MuteState.REMOVED);
    }

    // ── close / lock policy ──────────────────────────────────────────────────────────────────────

    @Test
    void closePolicySoftClosesADueThreadAndLeavesTheDefaultNeverClosing() {
        long host = newUser("host");
        // Override: chat closes 1h after the event ends; endAt = start + 2h. Millisecond-truncated so
        // the close instant round-trips losslessly through Postgres TIMESTAMPTZ (TM-419) — otherwise a
        // nanosecond Instant would not equal itself back on reload.
        Instant start = Instant.now().plus(Duration.ofHours(2)).truncatedTo(ChronoUnit.MILLIS);
        Event closing = seedEvent(host, 5, false, start.plus(Duration.ofHours(2)));
        closing.setChatCloseHours(1);
        closing = events.saveAndFlush(closing);
        rsvps.rsvp(caller(newUser("att-a")), closing.getId()); // create the thread

        Instant closesAt = closing.getEndAt().plus(Duration.ofHours(1));

        // Before the close instant: open + writable, and a not-yet-due close is a no-op.
        assertThat(lifecycle.isThreadReadOnly(closing, closesAt.minusSeconds(1))).isFalse();
        assertThat(lifecycle.closeThreadIfDue(closing, closesAt.minusSeconds(1))).isEmpty();
        assertThat(conversations.findByEventId(closing.getId()).orElseThrow().isClosed()).isFalse();

        // At/after the close instant: the thread is soft-closed and read-only.
        assertThat(lifecycle.closeThreadIfDue(closing, closesAt)).get().extracting(Conversation::isClosed).isEqualTo(true);
        Conversation reloaded = conversations.findByEventId(closing.getId()).orElseThrow();
        assertThat(reloaded.isClosed()).isTrue();
        assertThat(reloaded.getClosedAt()).isEqualTo(closesAt);
        assertThat(lifecycle.isThreadReadOnly(closing, closesAt)).isTrue();

        // An event with no override + the app default (never close) never becomes read-only.
        long host2 = newUser("host2");
        Event never = seedEvent(host2, 5, false, start.plus(Duration.ofHours(2)));
        rsvps.rsvp(caller(newUser("att-b")), never.getId());
        Instant farFuture = never.getEndAt().plus(Duration.ofDays(3650));
        assertThat(lifecycle.closeThreadIfDue(never, farFuture)).isEmpty();
        assertThat(lifecycle.isThreadReadOnly(never, farFuture)).isFalse();
    }

    // ── retention / cascade-delete ───────────────────────────────────────────────────────────────

    @Test
    void deletingTheEventCascadeDeletesItsThreadMembersAndMessages() {
        long host = newUser("host");
        Event event = seedEvent(host, 5, false, null);
        long attendee = newUser("attendee");
        rsvps.rsvp(caller(attendee), event.getId());

        Conversation thread = conversations.findByEventId(event.getId()).orElseThrow();
        long threadId = thread.getId();
        long messageId = messages.save(Message.fromUser(threadId, attendee, "salaam everyone")).getId();
        assertThat(members.findByConversationId(threadId)).isNotEmpty();

        // Hard-delete the event row (events are only soft-deleted in-app, so exercise the DB cascade
        // directly — the guarantee that a genuinely purged event takes its whole thread with it).
        jdbc.update("DELETE FROM events WHERE id = ?", event.getId());

        // The conversation, its memberships and its messages are all gone (V27's ON DELETE CASCADE).
        assertThat(conversations.findById(threadId)).isEmpty();
        assertThat(conversations.findByEventId(event.getId())).isEmpty();
        assertThat(members.findByConversationId(threadId)).isEmpty();
        assertThat(messages.findById(messageId)).isEmpty();
    }

    // ── fixtures ─────────────────────────────────────────────────────────────────────────────────

    private String uid(String label) {
        return ns + label;
    }

    private long newUser(String label) {
        String uid = uid(label);
        return users.findByFirebaseUid(uid)
                .orElseGet(() -> users.saveAndFlush(new User(uid, uid + "@example.com", label)))
                .getId();
    }

    private VerifiedUser caller(long userId) {
        User u = users.findById(userId).orElseThrow();
        return new VerifiedUser(u.getFirebaseUid(), u.getEmail());
    }

    /** A PUBLISHED, visible-now event starting in two hours, with the given capacity + waitlist flag. */
    private Event seedEvent(long hostId, Integer capacity, boolean includeWaitlistInChat, Instant endAt) {
        Instant now = Instant.now();
        Event event = new Event(
                "Marhaba Meetup",
                "A friendly meetup.",
                "Marhaba Cafe, 12 High St",
                "Europe/London",
                now.plus(Duration.ofHours(2)),
                now.minus(Duration.ofDays(1)),
                now.plus(Duration.ofDays(7)),
                hostId,
                now);
        event.setCapacity(capacity);
        event.setIncludeWaitlistInChat(includeWaitlistInChat);
        event.setEndAt(endAt);
        return events.saveAndFlush(event);
    }

    private ConversationMember membership(Conversation thread, long userId) {
        return members.findByConversationIdAndUserId(thread.getId(), userId).orElseThrow();
    }

    private AttendanceState attendanceState(long eventId, long userId) {
        return jdbc.queryForObject(
                "SELECT state FROM event_attendance WHERE event_id = ? AND user_id = ?",
                (rs, n) -> AttendanceState.valueOf(rs.getString(1)),
                eventId,
                userId);
    }
}
