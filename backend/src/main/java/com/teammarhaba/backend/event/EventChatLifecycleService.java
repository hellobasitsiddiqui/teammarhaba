package com.teammarhaba.backend.event;

import com.teammarhaba.backend.chat.Conversation;
import com.teammarhaba.backend.chat.ConversationMember;
import com.teammarhaba.backend.chat.ConversationMemberRepository;
import com.teammarhaba.backend.chat.ConversationRepository;
import com.teammarhaba.backend.chat.MemberRole;
import com.teammarhaba.backend.chat.MuteState;
import java.time.Instant;
import java.util.Optional;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The event group-chat lifecycle (TM-446): auto-creating an {@code EVENT_GROUP}
 * {@link Conversation} for an event and keeping its membership in sync with attendance. It is the
 * bridge between the attendance domain ({@link EventRsvpService}, which calls the hooks below inside
 * its own capacity-locked transaction) and the shared chat foundation (the {@code conversation} /
 * {@code conversation_member} tables from TM-435).
 *
 * <p><b>Thread creation</b> — a group thread is created lazily on the event's <em>first GOING
 * landing</em> (a GOING RSVP, or a waitlist claim that promotes to GOING). The event's host
 * ({@link Event#getCreatedBy()}) is added as an {@link MemberRole#ADMIN} member at that moment and
 * kept a member for the thread's whole life — the host / organiser is always in their event's chat
 * (AC: "host / admin are always members"). A waitlist-only situation cannot create a thread: on a
 * capacity-limited event the first RSVP always lands GOING (it fills a free slot), so a thread
 * always exists before anyone can be waitlisted.
 *
 * <p><b>Membership sync</b> — membership tracks attendance:
 *
 * <ul>
 *   <li>{@link #onGoing} — a member who lands GOING joins the thread (added as {@link
 *       MemberRole#MEMBER}, or reactivated if they had left before). Idempotent.
 *   <li>{@link #onWaitlisted} — a waitlisted member joins the thread <em>only</em> when the event's
 *       {@link Event#isIncludeWaitlistInChat()} flag is on (default off); otherwise they are not a
 *       chat member until they convert to GOING.
 *   <li>{@link #onLeave} — leaving the event (un-RSVP) removes the member from the thread ({@link
 *       MuteState#REMOVED} — the row is kept so a rejoin reactivates cleanly). The host is never
 *       removed. Idempotent, and a no-op for someone who was never a member (e.g. a waitlisted
 *       member on an event whose waitlist-in-chat flag is off).
 * </ul>
 *
 * <p>Because every {@link EventRsvpService} command runs under a {@code SELECT ... FOR UPDATE} lock
 * on the {@code events} row, all of these mutations for one event serialise — so the "create the
 * thread once" step can never race two concurrent first-GOING landings into two threads (the
 * partial-unique {@code event_id} index would in any case reject the second).
 *
 * <p><b>Close / lock policy</b> — {@link #closeThreadIfDue} soft-closes a thread once it is past its
 * resolved close window ({@link EventChatClosePolicy}: per-event override → per-city default → app
 * default of <em>never close</em>), and {@link #isThreadReadOnly} answers whether a thread is
 * read-only right now (manually closed, or past its policy close time). A closed thread is read-only;
 * the close is a soft-close ({@code conversation.closed_at}), never a hard delete, so history stays
 * readable.
 *
 * <p><b>Retention &amp; cascade-delete</b> — there is no time-based purge here: a thread and its
 * messages persist for the life of the event. Deleting the event row hard-removes its conversation,
 * members and messages (and any future reactions/attachments that hang off them) through the
 * {@code ON DELETE CASCADE} chain established in V27 — so no application code is needed for the
 * cascade; this service deliberately owns none of it.
 */
@Service
public class EventChatLifecycleService {

    private final ConversationRepository conversations;
    private final ConversationMemberRepository members;
    private final EventChatClosePolicy closePolicy;

    public EventChatLifecycleService(
            ConversationRepository conversations,
            ConversationMemberRepository members,
            EventChatClosePolicy closePolicy) {
        this.conversations = conversations;
        this.members = members;
        this.closePolicy = closePolicy;
    }

    /**
     * A member has landed GOING on {@code event} (a GOING RSVP or a claim). Create the event's group
     * thread if this is its first GOING landing, ensure the host is an ADMIN member, and add (or
     * reactivate) the member as a MEMBER. Idempotent: a re-RSVP by someone already GOING leaves the
     * membership untouched.
     */
    @Transactional
    public void onGoing(Event event, Long userId) {
        Conversation conversation = threadFor(event); // get-or-create (host added on create)
        ensureMember(conversation.getId(), event.getCreatedBy(), MemberRole.ADMIN); // host: always a member
        ensureMember(conversation.getId(), userId, MemberRole.MEMBER);
    }

    /**
     * A member has landed WAITLISTED on {@code event}. They join the thread <em>only</em> if the
     * event opts waitlisted attendees into chat ({@link Event#isIncludeWaitlistInChat()}, default
     * off); otherwise this is a no-op. Never creates the thread — creation is a GOING-only trigger
     * (and in practice a thread already exists, since GOING fills before a waitlist forms).
     */
    @Transactional
    public void onWaitlisted(Event event, Long userId) {
        if (!event.isIncludeWaitlistInChat()) {
            return;
        }
        conversations
                .findByEventId(event.getId())
                .ifPresent(conversation -> ensureMember(conversation.getId(), userId, MemberRole.MEMBER));
    }

    /**
     * A member has left {@code event} (un-RSVP). Remove them from the thread ({@link
     * MuteState#REMOVED} — the row is kept so a later rejoin reactivates cleanly). The host is never
     * removed (AC: host is always a member). A no-op when the event has no thread, when the caller is
     * the host, or when they were never an active member (idempotent, and safe for a waitlisted
     * leaver on a waitlist-in-chat-off event).
     */
    @Transactional
    public void onLeave(Event event, Long userId) {
        if (event.getCreatedBy().equals(userId)) {
            return; // the host stays a member even if they drop their own attendance
        }
        conversations
                .findByEventId(event.getId())
                .flatMap(conversation -> members.findByConversationIdAndUserId(conversation.getId(), userId))
                .filter(member -> member.getMute() != MuteState.REMOVED)
                .ifPresent(member -> {
                    member.setMute(MuteState.REMOVED);
                    members.save(member);
                });
    }

    /**
     * Soft-close {@code event}'s thread if it is past its resolved close window at {@code now}
     * (idempotent — a re-close never rewrites the original {@code closedAt}). Returns the thread when
     * one exists and is due to close, empty when the event never closes (the app default), is not yet
     * due, or has no thread. A closed thread is read-only.
     */
    @Transactional
    public Optional<Conversation> closeThreadIfDue(Event event, Instant now) {
        Optional<Instant> closesAt = closePolicy.closesAt(event);
        if (closesAt.isEmpty() || now.isBefore(closesAt.get())) {
            return Optional.empty(); // never closes, or not yet due
        }
        return conversations.findByEventId(event.getId()).map(conversation -> {
            conversation.close(closesAt.get()); // idempotent, first-moment-wins soft-close
            return conversations.save(conversation);
        });
    }

    /**
     * Whether {@code event}'s thread is read-only at {@code now}: {@code true} once it has been
     * soft-closed (manually, or its {@link EventChatClosePolicy} close time has passed). {@code false}
     * when the event has no thread yet or its thread is still open — including the default "never
     * close" case. The post endpoint (a later ticket) consults this to reject writes to a closed
     * thread; this ticket owns the resolution.
     */
    @Transactional(readOnly = true)
    public boolean isThreadReadOnly(Event event, Instant now) {
        return conversations
                .findByEventId(event.getId())
                .map(conversation -> conversation.isClosed() || closePolicy.isClosedAt(event, now))
                .orElse(false);
    }

    /** The event's group thread, creating it (and seeding the host as an ADMIN member) on first use. */
    private Conversation threadFor(Event event) {
        return conversations
                .findByEventId(event.getId())
                .orElseGet(() -> conversations.save(Conversation.forEvent(event.getId())));
    }

    /**
     * Add {@code userId} to the thread as {@code role}, or — if they already have a membership row —
     * reactivate it (clear any {@code READ_ONLY}/{@code REMOVED} mute) and, for the host, upgrade a
     * MEMBER row to ADMIN. Never downgrades an existing ADMIN (so a host who also RSVPs as an
     * attendee keeps their ADMIN role). The kept-row-plus-reactivate pattern is why {@code onLeave}
     * uses {@code REMOVED} rather than deleting: a rejoin is a clean flip back to active.
     */
    private void ensureMember(Long conversationId, Long userId, MemberRole role) {
        Optional<ConversationMember> existing = members.findByConversationIdAndUserId(conversationId, userId);
        if (existing.isEmpty()) {
            members.save(new ConversationMember(conversationId, userId, role));
            return;
        }
        ConversationMember member = existing.get();
        boolean changed = false;
        if (member.getMute() != MuteState.NONE) {
            member.setMute(MuteState.NONE); // reactivate a previously removed / read-only member
            changed = true;
        }
        if (role == MemberRole.ADMIN && member.getRole() != MemberRole.ADMIN) {
            member.setRole(MemberRole.ADMIN); // host hardening — never the reverse (no ADMIN downgrade)
            changed = true;
        }
        if (changed) {
            members.save(member);
        }
    }
}
