package com.teammarhaba.backend.chat;

import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/**
 * Revokes a member's live SSE subscription <em>after</em> the membership change that removed them commits
 * (TM-730). The moderation-removal / self-leave paths publish a {@link ConversationMemberRevokedEvent}
 * in-transaction; this listener subscribes {@code @TransactionalEventListener(phase = AFTER_COMMIT)} and
 * then completes the member's open streams for the thread via {@link ChatStreamService#disconnectMember}.
 *
 * <p>Two properties fall out of the ordering, exactly as with {@link MessageCreatedPushListener} (TM-579):
 *
 * <ul>
 *   <li><b>No premature revoke on rollback.</b> {@code AFTER_COMMIT} runs only when the removal truly
 *       commits, so a member whose removal rolled back keeps their still-valid stream.</li>
 *   <li><b>Off the write path.</b> The stream-completion work runs after the write transaction released
 *       its connection, so it never pins the writer.</li>
 * </ul>
 *
 * <p>Completing the stream fires the client's automatic reconnect, which re-runs the connect-time
 * membership gate ({@code ConversationReadService.assertMember}); a removed / self-left member is denied a
 * {@code 403} there, so the reconnect cannot restore live access. The listener is deliberately thin — the
 * publisher already resolved {@code userId → uid} — so {@link ChatStreamService} stays a pure transport.
 */
@Component
public class ConversationMemberRevokedListener {

    private final ChatStreamService streams;

    public ConversationMemberRevokedListener(ChatStreamService streams) {
        this.streams = streams;
    }

    /**
     * Post-commit hook: complete the removed member's open streams for the thread on this instance. Runs
     * only after the membership change committed, so a rolled-back removal never severs a live stream, and
     * the completion does not hold the write connection. Single-instance (same caveat as the broadcast
     * fan-out); the durable membership gate re-checked on reconnect is the cross-instance backstop.
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onMemberRevoked(ConversationMemberRevokedEvent event) {
        streams.disconnectMember(event.conversationId(), event.ownerUid());
    }
}
