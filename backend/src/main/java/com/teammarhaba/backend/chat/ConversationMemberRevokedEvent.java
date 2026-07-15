package com.teammarhaba.backend.chat;

/**
 * Domain event published <em>in-transaction</em> the moment a member loses access to a thread — a
 * moderation removal ({@link MuteState#REMOVED}, {@code ChatModerationService.muteMember}) or a
 * self-leave ({@link MuteState#LEFT}, {@code ConversationMembershipService.leave}). It is consumed
 * {@code @TransactionalEventListener(phase = AFTER_COMMIT)} by {@link ConversationMemberRevokedListener}
 * to revoke the member's live SSE subscription (TM-730).
 *
 * <p><b>Why after commit.</b> Publishing merely registers interest; the listener fires only once the
 * membership change genuinely commits. If the removal rolls back, the member keeps their (still valid)
 * stream — we never cut a live stream for a change that didn't stick. And, mirroring
 * {@link MessageCreatedEvent} / {@link MessageCreatedPushListener} (TM-579), the stream-completion work
 * runs off the write transaction so it never holds the write connection.
 *
 * <p><b>Carries the member's Firebase uid, not their numeric id.</b> The live stream registry
 * ({@link ChatStreamService}) keys open streams by the owner uid recorded at connect
 * ({@code caller.uid()}), so revocation is by uid. The removing path resolves {@code userId → uid} while
 * it still holds the membership context, so the listener stays a thin, id-free transport hook.
 *
 * @param conversationId the thread the member was removed from
 * @param ownerUid       the removed member's Firebase uid, whose open streams for the thread to complete;
 *                       {@code null} when the uid could not be resolved (revocation is then a no-op — the
 *                       durable membership gate re-checked on the next reconnect is the backstop)
 */
public record ConversationMemberRevokedEvent(long conversationId, String ownerUid) {}
