package com.teammarhaba.backend.testsupport;

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
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventChatLifecycleService;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.user.UserService;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * TEST-ONLY chat seed hook (TM-587) — populates a signed-in caller's chat with a couple of event
 * group threads + an admin "from TeamMarhaba" channel, each with messages and unread state, so the
 * Event Chat foundation screens (the conversation list TM-438, an open thread TM-448, the unread
 * Chat-tab badge TM-439) can be rendered and asserted against a <em>live</em> backend rather than the
 * route-mocked fixtures the TM-564 evidence harness had to use before a write path existed.
 *
 * <p><b>Why this is safe in prod: it never exists there.</b> The bean is gated two ways —
 * {@link ConditionalOnProperty}{@code (app.test-seed.enabled=true)}, which the base config leaves
 * {@code false} (so prod, which never sets it, has no bean), <em>and</em> {@link Profile}{@code
 * ("!prod")} as belt-and-suspenders, so even a mis-set flag on the prod profile can't create it. The
 * controller that exposes it ({@code ChatSeedController}) carries the identical guard, so the whole
 * seed surface is absent from a production context. {@code ChatSeedDisabledIntegrationTest} proves the
 * beans vanish when the flag is off (exactly as prod inherits it).
 *
 * <p><b>Faithful, not synthetic.</b> The event threads are created through the <em>real</em>
 * {@link EventChatLifecycleService#onGoing} lifecycle (a real event + the caller landing as its host
 * ADMIN member), and the admin channel through the real {@link Conversation#adminBroadcast(Long)}
 * per-user factory (TM-588) — the same two paths production uses — so what renders is the production
 * data model, only its rows are seeded. Messages are written straight to {@link MessageRepository}
 * (system notices with a {@code null} sender, human messages from seeded member users, and one from
 * the caller so the "mine" alignment TM-589 has something to show); this deliberately does <em>not</em>
 * go through the live post path ({@code MessagePostService}) so the seed neither fans out pushes nor
 * touches that (separately owned) hot file.
 *
 * <p><b>Idempotent</b> — keyed on the caller owning an {@link ConversationType#ADMIN_BROADCAST}
 * channel (a per-user singleton, V33): a re-seed of an already-seeded account is a no-op that returns
 * the current tallies, so the browser-e2e can call it on every run (and CI retry) without piling up
 * duplicate threads. The whole seed runs in one transaction, so a fresh account is seeded all-or-nothing.
 */
@Service
@Profile("!prod")
@ConditionalOnProperty(prefix = "app.test-seed", name = "enabled", havingValue = "true")
public class ChatSeedService {

    /** Deterministic firebase-uid prefix for the seeded "other member" accounts (find-or-create). */
    private static final String MEMBER_UID_PREFIX = "tm587-seed-";

    private final UserService users;
    private final UserRepository userRepository;
    private final EventRepository events;
    private final EventChatLifecycleService lifecycle;
    private final ConversationRepository conversations;
    private final ConversationMemberRepository members;
    private final MessageRepository messages;

    public ChatSeedService(
            UserService users,
            UserRepository userRepository,
            EventRepository events,
            EventChatLifecycleService lifecycle,
            ConversationRepository conversations,
            ConversationMemberRepository members,
            MessageRepository messages) {
        this.users = users;
        this.userRepository = userRepository;
        this.events = events;
        this.lifecycle = lifecycle;
        this.conversations = conversations;
        this.members = members;
        this.messages = messages;
    }

    /**
     * Seed the caller's chat (idempotent). Identity is the verified caller (never a client-supplied
     * id), resolved through the same JIT provisioning the rest of {@code /me} uses, so a caller only
     * ever seeds their own chat.
     *
     * @return a summary of what the caller's chat now holds ({@code alreadySeeded=true} when the call
     *     was a no-op because the account was seeded before)
     */
    @Transactional
    public ChatSeedResult seed(VerifiedUser caller) {
        Long callerId = users.provision(caller).getId();

        // Idempotency sentinel: the caller already owns an admin-broadcast channel → already seeded.
        // (A per-user singleton via V33's partial-unique index, so this is a genuine 0-or-1 check.)
        if (conversations.findByTypeAndOwnerUserId(ConversationType.ADMIN_BROADCAST, callerId).isPresent()) {
            return summary(callerId, true);
        }

        // A small cast of seeded "other members" so the event threads read as real group chats. The
        // message.sender_id FK to users(id) means non-system senders MUST be real rows — hence these.
        long priya = seededMember("priya", "Priya");
        long jordan = seededMember("jordan", "Jordan");
        long sam = seededMember("sam", "Sam");

        // ── Event thread A — populated + fully unread (8 messages, 7 unread for the caller) ───────
        Conversation dogWalk = eventThread(callerId, "Sunday Morning Dog Walk", List.of(priya, jordan, sam));
        Long a = dogWalk.getId();
        system(a, "You joined Sunday Morning Dog Walk");
        human(a, priya, "Morning all! Weather looks perfect for a walk ☀️");
        human(a, jordan, "Bringing my golden retriever Max — he loves company 🐕");
        human(a, callerId, "Perfect. North gate, 9am sharp — there's parking on Elm Street.");
        human(a, priya, "I'll bring some water and treats for the dogs 💧");
        human(a, sam, "Can't wait — first time joining, excited to meet everyone 🙌");
        human(a, priya, "See you all at the north gate at 9!");
        human(a, jordan, "Max says woof — translation: hurry up, humans 🐾");
        // Cursor left null (never read) → 7 unread: the system notice + the six OTHER members'
        // messages. The caller's own message never counts against them (TM-680).

        // ── Event thread B — populated but READ (0 unread) so the list shows a mix ────────────────
        Conversation runClub = eventThread(callerId, "Riverside 5k Run Club", List.of(jordan));
        Long b = runClub.getId();
        system(b, "You joined Riverside 5k Run Club");
        human(b, jordan, "Nice pace today everyone 👏");
        human(b, callerId, "Same time next week?");
        markRead(b, callerId); // advance the caller's cursor to the newest → this thread reads as READ

        // ── Admin "from TeamMarhaba" channel — 3 system notices, all unread ───────────────────────
        Conversation admin = adminChannel(callerId);
        Long c = admin.getId();
        system(c, "📣 Group chat has arrived! Your event chats now live under the Chat tab.");
        system(c, "Reminder: complete your profile to get better event matches.");
        system(c, "New events near you this weekend — check the Events tab.");
        // Cursor left null → all 3 unread. Total unread = 7 + 0 + 3 = 10 → the capped "9+" tab badge.

        return summary(callerId, false);
    }

    /** Find-or-create a seeded "other member" user (deterministic uid → idempotent across re-seeds). */
    private long seededMember(String key, String displayName) {
        String uid = MEMBER_UID_PREFIX + key;
        return userRepository
                .findByFirebaseUid(uid)
                .orElseGet(() -> userRepository.saveAndFlush(new User(uid, uid + "@teammarhaba.test", displayName)))
                .getId();
    }

    /**
     * Create an event owned by the caller and drive the REAL group-chat lifecycle to open its thread
     * (with the caller as its host ADMIN member), then add the other members. Returns the thread.
     */
    private Conversation eventThread(long callerId, String heading, List<Long> otherMembers) {
        Event event = events.saveAndFlush(newEvent(callerId, heading));
        // The production path: a first GOING landing opens the EVENT_GROUP thread + adds the host
        // (the caller here) as an ADMIN member. Same call EventRsvpService makes for a real RSVP.
        lifecycle.onGoing(event, callerId);
        Conversation thread = conversations.findByEventId(event.getId()).orElseThrow();
        for (Long userId : otherMembers) {
            if (!members.existsByConversationIdAndUserId(thread.getId(), userId)) {
                members.save(new ConversationMember(thread.getId(), userId, MemberRole.MEMBER));
            }
        }
        return thread;
    }

    /** A PUBLISHED, visible-now event starting in two hours — enough for the group thread to open. */
    private Event newEvent(long hostId, String heading) {
        Instant now = Instant.now();
        Event event = new Event(
                heading,
                "A friendly TeamMarhaba meetup. Seeded for chat foundation evidence (TM-587).",
                "Marhaba Community Hall, 1 Test Street",
                "Europe/London",
                now.plus(Duration.ofHours(2)),
                now.minus(Duration.ofDays(1)),
                now.plus(Duration.ofDays(30)),
                hostId,
                now);
        event.setCity("London");
        event.setCapacity(20);
        return event;
    }

    /** The caller's per-user admin-broadcast channel (TM-588) with the caller as a MEMBER. */
    private Conversation adminChannel(long callerId) {
        Conversation channel = conversations.save(Conversation.adminBroadcast(callerId));
        members.save(new ConversationMember(channel.getId(), callerId, MemberRole.MEMBER));
        return channel;
    }

    /** Persist a system / admin "from TeamMarhaba" message (null sender). */
    private void system(Long conversationId, String body) {
        messages.save(Message.fromSystem(conversationId, body, null));
    }

    /** Persist a human message from {@code senderId} (a real users.id — the FK requires it). */
    private void human(Long conversationId, long senderId, String body) {
        messages.save(Message.fromUser(conversationId, senderId, body));
    }

    /**
     * Advance the caller's read cursor for a thread to its newest live message, so the thread reads
     * as fully READ (0 unread). Mirrors the read API's cursor anchoring (TM-580): stamp from the
     * DB-authoritative newest {@code created_at}, which is exactly what {@code countUnread} compares
     * against, so no just-seeded message can linger as unread.
     */
    private void markRead(Long conversationId, long callerId) {
        Instant cursor = messages
                .findFirstByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(conversationId)
                .map(Message::getCreatedAt)
                .orElseGet(messages::databaseNow);
        ConversationMember member = members
                .findByConversationIdAndUserId(conversationId, callerId)
                .orElseThrow();
        member.markRead(cursor);
        members.save(member);
    }

    /** Tally the caller's current chat for the response (also used for the already-seeded no-op). */
    private ChatSeedResult summary(long callerId, boolean alreadySeeded) {
        List<ConversationMember> memberships = members.findByUserIdOrderByJoinedAtDesc(callerId).stream()
                .filter(m -> m.getMute() != MuteState.REMOVED)
                .toList();
        int eventThreads = 0;
        int adminThreads = 0;
        long unreadTotal = 0;
        for (ConversationMember m : memberships) {
            Optional<Conversation> thread = conversations.findById(m.getConversationId());
            if (thread.isEmpty()) {
                continue;
            }
            if (thread.get().getType() == ConversationType.EVENT_GROUP) {
                eventThreads++;
            } else {
                adminThreads++;
            }
            unreadTotal += messages.countUnread(m.getConversationId(), m.getUserId(), m.getLastReadAt());
        }
        return new ChatSeedResult(alreadySeeded, eventThreads, adminThreads, unreadTotal);
    }

    /**
     * The seed outcome (TM-587): how many of each thread kind the caller's chat now holds and their
     * aggregate unread — enough for the browser-e2e to log/assert without re-deriving it.
     *
     * @param alreadySeeded {@code true} when the call was a no-op (the account was seeded before)
     * @param eventThreads  the caller's EVENT_GROUP thread count
     * @param adminThreads  the caller's ADMIN_BROADCAST channel count
     * @param unreadTotal   the caller's aggregate unread across every thread (the Chat-tab badge value)
     */
    public record ChatSeedResult(boolean alreadySeeded, int eventThreads, int adminThreads, long unreadTotal) {}
}
