package com.teammarhaba.backend.chat;

import com.teammarhaba.backend.api.ConversationMessageResponse;
import com.teammarhaba.backend.api.RemovedMessageResponse;
import java.util.List;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/**
 * Broadcasts an author's own-message <b>edit</b> or <b>delete</b> (TM-467) over SSE <em>after</em> the
 * mutating transaction commits — the live-while-online transport (TM-464) for self-service edits. It is
 * the edit/delete sibling of {@link MessageCreatedStreamListener} (which broadcasts a fresh post): both
 * subscribe to an in-transaction domain event that {@link MessageAuthorService} publishes, and both
 * fire only {@code @TransactionalEventListener(phase = AFTER_COMMIT)}, so a rolled-back edit/delete
 * broadcasts nothing and the SSE send never holds the write connection.
 *
 * <p><b>Why a distinct listener (not folded into the create one).</b> An edit and a delete are NOT new
 * messages, so they must not ride {@link ChatStreamService#EVENT_MESSAGE} (whose client consumer upserts
 * a whole bubble) nor fire the push. They ride their own event names:
 *
 * <ul>
 *   <li><b>Edit</b> → {@link ChatStreamService#EVENT_MESSAGE_EDITED}, payload the edited message's read
 *       DTO (built exactly as the poster's own response is — empty reactions, since the broadcast is
 *       caller-independent and a subscriber re-syncs reactions/receipt over the read API). The client
 *       applies only the new body + {@code editedAt} to the message it already holds, so an edit
 *       re-renders in place without clobbering that message's reactions / receipt / reply quote.</li>
 *   <li><b>Delete</b> → {@link ChatStreamService#EVENT_MESSAGE_DELETED}, payload a small
 *       {@link RemovedMessageResponse} ({@code messageId} + {@code conversationId}); the client drops
 *       that message from its open thread by id.</li>
 * </ul>
 *
 * <p>{@link ChatStreamService#broadcast} is best-effort and single-instance (see that class): it reaches
 * only streams open for this thread on this instance and returns 0 when none are. A member not reached
 * live re-syncs over the read API on their next poll / reconnect (the read filters {@code deleted_at IS
 * NULL} and carries the current body), so a missed edit/delete frame is never lossy.
 */
@Component
public class MessageMutationStreamListener {

    private final ChatStreamService stream;

    public MessageMutationStreamListener(ChatStreamService stream) {
        this.stream = stream;
    }

    /**
     * Post-commit hook: live-re-render an edited message to members currently connected to its thread's
     * SSE stream. Runs only after the edit transaction committed, so a rolled-back edit is never
     * broadcast. The payload mirrors the poster's own response DTO (empty reactions — caller-independent
     * frame); the client treats it as a body/{@code editedAt} patch.
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onMessageEdited(MessageEditedEvent event) {
        Message message = event.message();
        ConversationMessageResponse payload = ConversationMessageResponse.from(message, List.of());
        stream.broadcast(message.getConversationId(), ChatStreamService.EVENT_MESSAGE_EDITED, payload);
    }

    /**
     * Post-commit hook: tell members currently connected to the thread's SSE stream to drop a
     * just-deleted message by id. Runs only after the delete transaction committed, so a rolled-back
     * delete is never broadcast. The payload is a thin acknowledgement (no body — the message is gone).
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onMessageDeleted(MessageDeletedEvent event) {
        RemovedMessageResponse payload =
                new RemovedMessageResponse(event.messageId(), event.conversationId(), true, event.deletedAt());
        stream.broadcast(event.conversationId(), ChatStreamService.EVENT_MESSAGE_DELETED, payload);
    }
}
