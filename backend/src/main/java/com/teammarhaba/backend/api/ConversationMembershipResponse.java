package com.teammarhaba.backend.api;

import com.teammarhaba.backend.chat.ConversationMember;

/**
 * The caller's own self-service membership state for one thread (TM-471) — the body the member-facing
 * mute / unmute / leave / rejoin endpoints return so the client can reflect the new state without a
 * refetch. A DTO, never the JPA {@link ConversationMember} entity, so the HTTP contract stays
 * decoupled from the mapping and reviewable in {@code openapi.json}.
 *
 * <p>It exposes only the two self-service levers this ticket owns (deliberately not the moderation
 * {@code role}/{@code MuteState} internals): whether the caller has silenced this thread's push, and
 * whether they have left it. The client renders the correct control from these — "Mute"↔"Unmute" and
 * "Leave"↔"Rejoin".
 *
 * @param conversationId     the thread the state belongs to
 * @param notificationsMuted whether the caller has self-muted this thread's new-message push (they are
 *                           still an active member — the thread is visible and they can read + post)
 * @param left               whether the caller has self-left this thread (hidden until they rejoin);
 *                           their event RSVP is unaffected
 */
public record ConversationMembershipResponse(Long conversationId, boolean notificationsMuted, boolean left) {

    /** Snapshot a membership row into the response the self-service endpoints return. */
    public static ConversationMembershipResponse of(ConversationMember member) {
        return new ConversationMembershipResponse(
                member.getConversationId(), member.isNotificationsMuted(), member.hasLeft());
    }
}
