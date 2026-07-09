package com.teammarhaba.backend.chat;

import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/**
 * Fires the new-message push fan-out <em>after</em> the message-write transaction commits (TM-579).
 *
 * <p>The chat write paths (e.g. {@link MessagePostService#post}) publish a {@link MessageCreatedEvent}
 * in-transaction; this listener subscribes with {@code @TransactionalEventListener(phase = AFTER_COMMIT)}
 * and only then delegates to the reusable {@link NewMessageNotifier} seam (TM-437). Two properties fall
 * out of that ordering, and they are exactly the bug this ticket closes:
 *
 * <ul>
 *   <li><b>No phantom push on rollback.</b> {@code AFTER_COMMIT} runs only when the surrounding
 *       transaction truly commits. If the write rolls back (a failure after the message was persisted),
 *       the listener never runs, so nobody is pushed about a message that no longer exists.</li>
 *   <li><b>The FCM fan-out no longer holds the write connection.</b> By the time this runs the write
 *       transaction has committed and released its DB connection, so the (potentially slow) push network
 *       call is off the write path — it can't pin the writer while it talks to FCM.</li>
 * </ul>
 *
 * <p>This mirrors {@link com.teammarhaba.backend.event.EventLifecycleNotifier}, the other post-commit
 * notifier in the codebase: the write path stays transaction-focused and merely announces what
 * happened, and the push is a separate, post-commit concern. Keeping the listener thin (and separate
 * from {@link NewMessageNotifier}) preserves the notifier's contract as a pure, directly-callable
 * delivery seam — the notifier's own tests still invoke {@link NewMessageNotifier#onMessageCreated}
 * synchronously, while production wiring reaches it only after commit through this listener.
 */
@Component
public class MessageCreatedPushListener {

    private final NewMessageNotifier notifier;

    public MessageCreatedPushListener(NewMessageNotifier notifier) {
        this.notifier = notifier;
    }

    /**
     * Post-commit hook: fan the new message's push out to the thread's other active members. Runs only
     * after the write transaction committed, so a rolled-back message never pushes and the FCM call does
     * not hold the write connection. The notifier itself opens no transaction of its own — its recipient
     * reads run in their own short auto-commit transactions and the FCM send holds no DB connection.
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onMessageCreated(MessageCreatedEvent event) {
        notifier.onMessageCreated(event.message());
    }
}
