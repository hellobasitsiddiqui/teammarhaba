package com.teammarhaba.backend.api;

import com.teammarhaba.backend.chat.ConversationMember;
import com.teammarhaba.backend.chat.MuteState;

/**
 * The result of an app admin changing a thread member's mute / removal state (TM-449) — returned by
 * {@code POST /api/v1/admin/conversations/{conversationId}/members/{userId}/mute}. Echoes back the
 * applied {@link MuteState} so the moderation UI can confirm the new state without a re-read.
 *
 * @param conversationId the thread the member belongs to
 * @param userId         the member's {@code users.id}
 * @param mute           the mute / removal state now in effect ({@code NONE} / {@code READ_ONLY} / {@code REMOVED})
 */
public record MemberMuteResponse(long conversationId, long userId, MuteState mute) {

    /** Map an updated {@link ConversationMember} to its wire form. */
    public static MemberMuteResponse from(ConversationMember member) {
        return new MemberMuteResponse(member.getConversationId(), member.getUserId(), member.getMute());
    }
}
