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
import com.teammarhaba.backend.chat.MessageKind;
import com.teammarhaba.backend.chat.MessageRepository;
import com.teammarhaba.backend.chat.MuteState;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
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

    // ── opening message auto-post (TM-710) ─────────────────────────────────────────────────────────

    @Test
    void openingMessageIsAutoPostedOnceAsAnAnnouncementWhenTheChatFirstOpens() {
        long host = newUser("host");
        Event event = seedEventWithOpeningMessage(host, "Welcome! Please read the venue rules.");
        long attendee = newUser("attendee");

        // Chat opens on the first GOING landing.
        rsvps.rsvp(caller(attendee), event.getId());

        Conversation thread = conversations.findByEventId(event.getId()).orElseThrow();
        var posted = messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId());
        assertThat(posted).hasSize(1);
        Message opening = posted.get(0);
        assertThat(opening.getKind()).isEqualTo(MessageKind.ANNOUNCEMENT);
        assertThat(opening.getBody()).isEqualTo("Welcome! Please read the venue rules.");
        assertThat(opening.isSystem()).isTrue(); // system "from TeamMarhaba" — no acting author on the RSVP path

        // The idempotency stamp was set.
        assertThat(events.findById(event.getId()).orElseThrow().getOpeningMessagePostedAt())
                .isNotNull();
    }

    @Test
    void openingMessageIsNotDuplicatedOnASecondChatOpen() {
        long host = newUser("host");
        Event event = seedEventWithOpeningMessage(host, "See you all there!");
        long first = newUser("first");
        long second = newUser("second");

        // First GOING landing opens the chat and auto-posts.
        rsvps.rsvp(caller(first), event.getId());
        Conversation thread = conversations.findByEventId(event.getId()).orElseThrow();
        assertThat(messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId()))
                .hasSize(1);

        // A SECOND GOING landing re-enters onGoing (a "re-open"): the idempotency guard must prevent a
        // second auto-post. Also simulate a re-RSVP by the first attendee (leave + rejoin), another
        // onGoing call, to be sure a redeploy/replay path can't duplicate it either.
        rsvps.rsvp(caller(second), event.getId());
        rsvps.cancelRsvp(caller(first), event.getId());
        rsvps.rsvp(caller(first), event.getId());

        var opening = messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId())
                .stream()
                .filter(m -> m.getKind() == MessageKind.ANNOUNCEMENT)
                .toList();
        assertThat(opening).as("opening message posted exactly once across re-opens").hasSize(1);
    }

    @Test
    void openingMessageIsNotDuplicatedWhenTwoUsersRsvpConcurrently() throws Exception {
        // TM-710 concurrency guard: two users going GOING at the SAME time race on the first chat-open.
        // The dedup relies on opening_message_posted_at being stamped inside the RSVP transaction that
        // holds the pessimistic event-row lock (EventRepository.findByIdForUpdate) — the second
        // transaction blocks on the lock, and by the time it reads the event the stamp is committed, so
        // it must NOT auto-post again. Without the lock-scoped stamp both threads would see a pending
        // opening message and post twice. This test (and the whole class) is deliberately NOT
        // @Transactional: each rsvp() runs in its own committed transaction, exactly as production —
        // a test-level transaction would serialise nothing and defeat the race.
        long host = newUser("host");
        Event event = seedEventWithOpeningMessage(host, "Salaam! Doors open at 7."); // capacity 5 → both land GOING
        VerifiedUser alice = caller(newUser("alice"));
        VerifiedUser bob = caller(newUser("bob"));
        long eventId = event.getId();

        // Two threads, released as simultaneously as possible: both await the barrier, then hit the
        // real @Transactional RSVP entry point (own tx each, both contending for the event-row lock).
        CyclicBarrier startTogether = new CyclicBarrier(2);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            List<Future<RsvpResult>> results = pool.invokeAll(List.of(
                    () -> {
                        startTogether.await(5, TimeUnit.SECONDS);
                        return rsvps.rsvp(alice, eventId);
                    },
                    () -> {
                        startTogether.await(5, TimeUnit.SECONDS);
                        return rsvps.rsvp(bob, eventId);
                    }));
            for (Future<RsvpResult> result : results) {
                // .get() surfaces any exception from either thread — both RSVPs must succeed as GOING.
                assertThat(result.get(30, TimeUnit.SECONDS).state()).isEqualTo(AttendanceState.GOING);
            }
        } finally {
            pool.shutdownNow();
        }

        // EXACTLY ONE announcement, no matter who won the race — never two.
        Conversation thread = conversations.findByEventId(eventId).orElseThrow();
        var announcements = messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId())
                .stream()
                .filter(m -> m.getKind() == MessageKind.ANNOUNCEMENT)
                .toList();
        assertThat(announcements)
                .as("concurrent first chat-open auto-posts the opening message exactly once")
                .hasSize(1);
        assertThat(announcements.get(0).getBody()).isEqualTo("Salaam! Doors open at 7.");
        assertThat(events.findById(eventId).orElseThrow().getOpeningMessagePostedAt())
                .as("idempotency stamp committed by the winning transaction")
                .isNotNull();
    }

    @Test
    void noOpeningMessageConfiguredMeansNothingIsAutoPosted() {
        long host = newUser("host");
        Event event = seedEvent(host, 5, false, null); // no opening message
        long attendee = newUser("attendee");

        rsvps.rsvp(caller(attendee), event.getId());

        Conversation thread = conversations.findByEventId(event.getId()).orElseThrow();
        assertThat(messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId()))
                .as("no opening message → nothing auto-posted")
                .isEmpty();
        assertThat(events.findById(event.getId()).orElseThrow().getOpeningMessagePostedAt())
                .isNull();
    }

    @Test
    void blankOpeningMessageIsTreatedAsNone() {
        long host = newUser("host");
        Event event = seedEventWithOpeningMessage(host, "   "); // blank = none
        long attendee = newUser("attendee");

        rsvps.rsvp(caller(attendee), event.getId());

        Conversation thread = conversations.findByEventId(event.getId()).orElseThrow();
        assertThat(messages.findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(thread.getId()))
                .isEmpty();
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

    // ── self-leave stickiness against the RSVP re-sync (TM-471) ───────────────────────────────────

    @Test
    void selfLeftMemberIsNotReactivatedByAFreshGoingLanding() {
        // A member who has SELF-LEFT the chat (TM-471) while still attending must not be silently
        // dragged back in by the RSVP→membership re-sync. A fresh GOING landing (here driven directly
        // via the lifecycle hook, the same call EventRsvpService makes) leaves a LEFT member LEFT —
        // only an explicit rejoin returns them. This is the interaction distinct from a REMOVED member,
        // whom the same hook DOES reactivate (rejoiningReactivatesTheSameMembershipRow).
        long host = newUser("host");
        Event event = seedEvent(host, 5, false, null);
        long attendee = newUser("attendee");

        rsvps.rsvp(caller(attendee), event.getId()); // GOING → active member
        Conversation thread = conversations.findByEventId(event.getId()).orElseThrow();

        // The member self-leaves the chat (their event RSVP is untouched — still GOING).
        ConversationMember member = membership(thread, attendee);
        member.leave();
        members.save(member);

        // A fresh GOING landing / re-sync fires again — must NOT reactivate the self-left member.
        lifecycle.onGoing(event, attendee);

        assertThat(membership(thread, attendee).getMute())
                .as("self-leave is sticky: a GOING re-sync does not reactivate a LEFT member")
                .isEqualTo(MuteState.LEFT);
        assertThat(attendanceState(event.getId(), attendee))
                .as("RSVP is unaffected by self-leaving the chat")
                .isEqualTo(AttendanceState.GOING);
    }

    @Test
    void unRsvpDoesNotOverwriteASelfLeaveWithRemoved() {
        // Un-RSVPing the event after self-leaving the chat must not flip the LEFT row to REMOVED —
        // otherwise a later re-RSVP (which reactivates REMOVED) would silently re-add them. Keeping the
        // row LEFT preserves the self-leave across the whole un-RSVP → re-RSVP round-trip.
        long host = newUser("host");
        Event event = seedEvent(host, 5, false, null);
        long attendee = newUser("attendee");

        rsvps.rsvp(caller(attendee), event.getId());
        Conversation thread = conversations.findByEventId(event.getId()).orElseThrow();
        ConversationMember member = membership(thread, attendee);
        member.leave();
        members.save(member);

        rsvps.cancelRsvp(caller(attendee), event.getId()); // un-RSVP → onLeave

        assertThat(membership(thread, attendee).getMute())
                .as("onLeave leaves a self-LEFT row LEFT (never overwrites it with REMOVED)")
                .isEqualTo(MuteState.LEFT);
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

    // ── scheduled close sweep (TM-578) ───────────────────────────────────────────────────────────

    @Test
    void sweepSoftClosesOnlyThreadsThatArePastTheirCloseWindow() {
        long host = newUser("host");

        // Three already-ended events, each with its own open group thread:
        //  (1) DUE — closes 1h after end, ended 2h ago → its close instant is an hour in the past.
        Event due = seedEndedEventWithOpenThread(host, 1, Duration.ofHours(2));
        //  (2) NOT YET DUE — closes 24h after end, ended 5m ago → close instant is ~a day in the future.
        Event notYet = seedEndedEventWithOpenThread(host, 24, Duration.ofMinutes(5));
        //  (3) NEVER CLOSES — no override + app default unset (test profile) → filtered out of the sweep.
        Event never = seedEndedEventWithOpenThread(host, null, Duration.ofHours(2));

        Instant now = Instant.now();
        int closed = lifecycle.sweepDueThreadCloses(now, 50);

        // The due thread is soft-closed; the not-yet-due and never-close ones stay open. The sweep is a
        // GLOBAL reconcile (not scoped to this test's events), so the returned count reflects every
        // due-open thread in the shared test DB — assert it closed at least our due one, and verify the
        // per-event outcomes below (which are the real ACs) rather than pinning an exact global count.
        assertThat(closed).isGreaterThanOrEqualTo(1);
        assertThat(conversations.findByEventId(due.getId()).orElseThrow().isClosed()).isTrue();
        assertThat(conversations.findByEventId(notYet.getId()).orElseThrow().isClosed())
                .as("a thread inside its close window is left open").isFalse();
        assertThat(conversations.findByEventId(never.getId()).orElseThrow().isClosed())
                .as("a never-closing thread is never swept").isFalse();

        // The stamped thread reads read-only now — the stored flag reactions/posts (TM-574) key on —
        // and the stamp is the policy close instant (end + 1h).
        Conversation stamped = conversations.findByEventId(due.getId()).orElseThrow();
        assertThat(lifecycle.isThreadReadOnly(due, now)).isTrue();
        assertThat(stamped.getClosedAt()).isEqualTo(due.getEndAt().plus(Duration.ofHours(1)));

        // Idempotent: a second sweep closes nothing more and never rewrites the original stamp.
        Instant firstStamp = stamped.getClosedAt();
        assertThat(lifecycle.sweepDueThreadCloses(now, 50)).isZero();
        assertThat(conversations.findByEventId(due.getId()).orElseThrow().getClosedAt()).isEqualTo(firstStamp);
    }

    @Test
    void sweepIsBoundedByTheBatchLimit() {
        long host = newUser("host");
        // Two due threads, but a batch cap of 1 → only one closes this pass; the backlog drains next tick.
        Event a = seedEndedEventWithOpenThread(host, 1, Duration.ofHours(3));
        Event b = seedEndedEventWithOpenThread(host, 1, Duration.ofHours(2));

        Instant now = Instant.now();
        assertThat(lifecycle.sweepDueThreadCloses(now, 1)).isEqualTo(1);

        long closedCount = java.util.stream.Stream.of(a, b)
                .filter(e -> conversations.findByEventId(e.getId()).orElseThrow().isClosed())
                .count();
        assertThat(closedCount).as("only one of the two due threads closed under a batch cap of 1").isEqualTo(1);

        // The next pass (still capped at 1) mops up the remaining one — both are closed after two ticks.
        assertThat(lifecycle.sweepDueThreadCloses(now, 1)).isEqualTo(1);
        assertThat(conversations.findByEventId(a.getId()).orElseThrow().isClosed()).isTrue();
        assertThat(conversations.findByEventId(b.getId()).orElseThrow().isClosed()).isTrue();
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

    /** A visible-now event (as {@link #seedEvent}) carrying an opening message (TM-710). */
    private Event seedEventWithOpeningMessage(long hostId, String openingMessage) {
        Event event = seedEvent(hostId, 5, false, null);
        event.setOpeningMessage(openingMessage);
        return events.saveAndFlush(event);
    }

    /**
     * A PUBLISHED event that has already ENDED ({@code endedAgo} before now) with the given
     * {@code chatCloseHours} override ({@code null} = inherit → never close in the test profile), plus
     * an OPEN {@code EVENT_GROUP} thread created directly. The thread is seeded straight through the
     * conversation repository rather than via an RSVP because RSVP's booking-cutoff / finished-event
     * guards would reject a past event — and the close sweep only needs an event + an open thread.
     * Instants are millisecond-truncated so the policy close instant round-trips losslessly through
     * Postgres {@code TIMESTAMPTZ} (TM-419), letting the test assert the exact stamped value.
     */
    private Event seedEndedEventWithOpenThread(long hostId, Integer chatCloseHours, Duration endedAgo) {
        Instant now = Instant.now().truncatedTo(ChronoUnit.MILLIS);
        Instant endAt = now.minus(endedAgo);
        Instant startAt = endAt.minus(Duration.ofHours(2));
        Event event = new Event(
                "Ended Meetup",
                "An ended meetup.",
                "Marhaba Cafe, 12 High St",
                "Europe/London",
                startAt,
                now.minus(Duration.ofDays(2)), // visibility opened in the past
                now.minus(Duration.ofHours(1)), // visibility already closed — irrelevant to the sweep
                hostId,
                now);
        event.setCapacity(5);
        event.setEndAt(endAt);
        event.setChatCloseHours(chatCloseHours);
        event = events.saveAndFlush(event);
        conversations.save(Conversation.forEvent(event.getId())); // open thread (closed_at null)
        return event;
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
