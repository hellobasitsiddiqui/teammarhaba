package com.teammarhaba.backend.chat;

import com.teammarhaba.backend.api.ConversationMembershipResponse;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.AttendanceState;
import com.teammarhaba.backend.event.EventAttendanceRepository;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.ConflictException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The MEMBER-facing self-service over one's own thread membership (TM-471): mute / unmute a thread's
 * push, and leave / rejoin a thread — all WITHOUT touching the caller's event RSVP. This is the
 * member's own lever, deliberately DISTINCT from:
 *
 * <ul>
 *   <li>admin moderation (a moderator muting/kicking someone else — the {@link MuteState#READ_ONLY} /
 *       {@link MuteState#REMOVED} states); and
 *   <li>un-RSVPing the event ({@code EventChatLifecycleService.onLeave}, which drops chat membership as
 *       a side effect of leaving the event). Here the RSVP stays GOING.
 * </ul>
 *
 * <p><b>Identity is always the verified caller.</b> Every method resolves the acting member from the
 * {@link VerifiedUser} principal via {@link UserService#provision} (the same just-in-time provisioning
 * the rest of the {@code /me} surface uses), never from a client-supplied id — so a caller can only
 * ever act on their OWN membership (the "owner-scoped" AC).
 *
 * <p><b>The two levers.</b>
 *
 * <ul>
 *   <li><b>Mute / unmute</b> flips the orthogonal {@code notifications_muted} flag (TM-471). A muted
 *       member stays a full {@link MuteState#NONE active} member — the thread is still visible and they
 *       can still read and post; only the new-message push fan-out ({@code NewMessageNotifier}, and any
 *       future @everyone/@here mention fan-out) skips them. That is why mute is a boolean and not a
 *       {@link MuteState}: no {@code MuteState} value keeps posting while suppressing push.</li>
 *   <li><b>Leave / rejoin</b> flips the caller's {@link MuteState} between {@link MuteState#NONE} and
 *       {@link MuteState#LEFT}. Leaving hides the thread and drops the member from reads/roster/push
 *       (like a kick) but is self-reversible and — crucially — <b>sticky against the RSVP re-sync</b>:
 *       {@code EventChatLifecycleService} never silently reactivates a {@code LEFT} member on the next
 *       GOING landing, so re-confirming attendance does not drag them back into a chat they left. They
 *       return only by calling {@link #rejoin} here.</li>
 * </ul>
 *
 * <p><b>The gate.</b> Every operation requires the caller's own membership row and treats a {@link
 * MuteState#REMOVED} (kicked) member — and an unknown / foreign thread (no row) — as an identical
 * {@code 403}, so a kicked member can't act on the thread and thread ids can't be probed (mirroring
 * the read gate). A {@code LEFT} row is the caller's own valid self-state, so it IS resolved (rejoin
 * needs it).
 *
 * <p><b>Rejoin eligibility.</b> A member may rejoin an event thread only while still chat-eligible on
 * the event — {@link AttendanceState#GOING}, or {@link AttendanceState#WAITLISTED} when the event opts
 * waitlisted attendees into chat (matching {@code EventChatLifecycleService}'s own membership rule). A
 * caller who has since un-RSVPed gets a {@code 409} pointing them to re-RSVP the event first, so this
 * endpoint can never re-add someone to the chat of an event they no longer attend. A non-event (admin
 * broadcast) thread has no attendance concept, so its rejoin is unconditional.
 *
 * <p>All four operations are idempotent: muting an already-muted thread, leaving an already-left one,
 * or rejoining one you're already in each returns the current state without error.
 */
@Service
public class ConversationMembershipService {

    private final UserService users;
    private final ConversationRepository conversations;
    private final ConversationMemberRepository members;
    private final EventRepository events;
    private final EventAttendanceRepository attendance;

    public ConversationMembershipService(
            UserService users,
            ConversationRepository conversations,
            ConversationMemberRepository members,
            EventRepository events,
            EventAttendanceRepository attendance) {
        this.users = users;
        this.conversations = conversations;
        this.members = members;
        this.events = events;
        this.attendance = attendance;
    }

    /**
     * Self-mute this thread's push (TM-471). The caller stays an active, visible member who can read
     * and post — only new-message push is suppressed. Idempotent.
     *
     * @throws AccessDeniedException {@code 403} if the caller is not a member (or is kicked / the thread
     *     is unknown)
     */
    @Transactional
    public ConversationMembershipResponse mute(VerifiedUser caller, Long conversationId) {
        ConversationMember member = requireOwnMembership(conversationId, callerId(caller));
        member.muteNotifications();
        members.save(member);
        return ConversationMembershipResponse.of(member);
    }

    /**
     * Un-mute this thread's push (TM-471) — the caller returns to receiving new-message pushes.
     * Idempotent.
     *
     * @throws AccessDeniedException {@code 403} if the caller is not a member (or is kicked / the thread
     *     is unknown)
     */
    @Transactional
    public ConversationMembershipResponse unmute(VerifiedUser caller, Long conversationId) {
        ConversationMember member = requireOwnMembership(conversationId, callerId(caller));
        member.unmuteNotifications();
        members.save(member);
        return ConversationMembershipResponse.of(member);
    }

    /**
     * Self-leave this thread (TM-471): hide/exit it while the event RSVP is untouched (the caller stays
     * GOING). Idempotent — leaving an already-left thread is a no-op success.
     *
     * @throws AccessDeniedException {@code 403} if the caller is not a member (or is kicked / the thread
     *     is unknown)
     * @throws ConflictException {@code 409} if the caller is the thread's {@link MemberRole#ADMIN} —
     *     the organiser / broadcaster is always a member of their own thread and cannot leave it
     */
    @Transactional
    public ConversationMembershipResponse leave(VerifiedUser caller, Long conversationId) {
        ConversationMember member = requireOwnMembership(conversationId, callerId(caller));
        if (member.getRole() == MemberRole.ADMIN) {
            // The host / broadcaster is always a member of their own thread (mirrors the lifecycle's
            // "host is never removed"), so they cannot leave it — only mute it.
            throw new ConflictException("As the organiser you can't leave your own event chat.");
        }
        if (!member.hasLeft()) {
            member.leave();
            members.save(member);
        }
        return ConversationMembershipResponse.of(member);
    }

    /**
     * Self-rejoin a thread the caller had left (TM-471) — back to an active member. Allowed only while
     * the caller is still chat-eligible on the event (see class doc). Idempotent — rejoining a thread
     * you're already in is a no-op success.
     *
     * @throws AccessDeniedException {@code 403} if the caller is not a member (or is kicked / the thread
     *     is unknown)
     * @throws ConflictException {@code 409} if the caller has left the event (no longer GOING / eligible)
     *     and so can't rejoin its chat until they re-RSVP the event
     */
    @Transactional
    public ConversationMembershipResponse rejoin(VerifiedUser caller, Long conversationId) {
        Long userId = callerId(caller);
        ConversationMember member = requireOwnMembership(conversationId, userId);
        if (member.hasLeft()) {
            requireRejoinEligible(conversationId, userId);
            member.rejoin();
            members.save(member);
        }
        return ConversationMembershipResponse.of(member);
    }

    /** Resolve the verified caller to their numeric user id (just-in-time provisioning). */
    private Long callerId(VerifiedUser caller) {
        return users.provision(caller).getId();
    }

    /**
     * The caller's own membership row, or a {@code 403}. A {@link MuteState#REMOVED} (kicked) membership
     * and an unknown / foreign thread (no row) are both a uniform {@code 403}, so a kicked member can't
     * act and thread ids can't be probed — mirroring the read gate. A {@link MuteState#LEFT} row is the
     * caller's own valid self-state and is returned (rejoin operates on it).
     */
    private ConversationMember requireOwnMembership(Long conversationId, Long userId) {
        return members.findByConversationIdAndUserId(conversationId, userId)
                .filter(member -> member.getMute() != MuteState.REMOVED)
                .orElseThrow(() -> new AccessDeniedException("You are not a member of this thread."));
    }

    /**
     * Assert the caller may still rejoin this thread. For an {@code EVENT_GROUP} thread they must be
     * chat-eligible on the event — {@link AttendanceState#GOING}, or {@link AttendanceState#WAITLISTED}
     * when the event includes waitlisted members in chat (the same rule the lifecycle uses to decide
     * membership). A non-event thread (admin broadcast) has no attendance gate. A missing event /
     * attendance row is treated as ineligible.
     *
     * @throws ConflictException {@code 409} when the caller is no longer attending the event
     */
    private void requireRejoinEligible(Long conversationId, Long userId) {
        Conversation thread = conversations
                .findById(conversationId)
                // Shouldn't happen (we just resolved a membership row), but if the thread vanished stay
                // uniform at 403 rather than 500-ing.
                .orElseThrow(() -> new AccessDeniedException("You are not a member of this thread."));

        Long eventId = thread.getEventId();
        if (eventId == null) {
            return; // a non-event (admin broadcast) thread has no attendance gate
        }

        boolean eligible = events.findById(eventId)
                .flatMap(event -> attendance
                        .findByEventIdAndUserId(eventId, userId)
                        .map(row -> row.getState() == AttendanceState.GOING
                                || (row.getState() == AttendanceState.WAITLISTED && event.isIncludeWaitlistInChat())))
                .orElse(false);
        if (!eligible) {
            throw new ConflictException(
                    "You're no longer attending this event, so you can't rejoin its chat. Rejoin the event first.");
        }
    }
}
