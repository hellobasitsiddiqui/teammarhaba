package com.teammarhaba.backend.chat;

import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/**
 * Fires the @mention fan-out <em>after</em> the message-write transaction commits (TM-469) — the
 * mention sibling of {@link MessageCreatedPushListener}.
 *
 * <p>{@link MessagePostService#post} already publishes a {@link MessageCreatedEvent} in-transaction the
 * moment a message row is persisted; this listener subscribes {@code AFTER_COMMIT} and delegates to
 * {@link MentionNotifier}, which re-parses the committed body and writes each mentioned member a durable
 * inbox notification. Riding the same post-commit event as the push fan-out (rather than an in-line call
 * inside the post path) is deliberate and buys the same two properties TM-579 established:
 *
 * <ul>
 *   <li><b>No phantom mention on rollback.</b> {@code AFTER_COMMIT} runs only when the post truly
 *       commits, so a rolled-back message mentions nobody — nobody gets a bell row for a message that
 *       never existed.</li>
 *   <li><b>The notification writes don't hold the write connection.</b> By the time this runs the post
 *       transaction has committed and released its connection; {@link MentionNotifier} then reads +
 *       writes in {@link org.springframework.transaction.annotation.Propagation#REQUIRES_NEW} inbox
 *       transactions of its own (via {@code NotificationWriter}), off the post's critical path.</li>
 * </ul>
 *
 * <p>Kept as its own listener (not folded into {@link MessageCreatedPushListener}) so the two concerns
 * — the transient push and the durable mention row — stay independently testable and one failing can't
 * suppress the other. Both consume the one event; their order is not significant (each targets its own
 * store/transport).
 */
@Component
public class MessageCreatedMentionListener {

    private final MentionNotifier mentions;

    public MessageCreatedMentionListener(MentionNotifier mentions) {
        this.mentions = mentions;
    }

    /**
     * Post-commit hook: parse the just-committed message for @mentions and write the mentioned members
     * their durable notifications. Runs only after the write transaction committed (so a rolled-back
     * post mentions nobody) and off the write connection.
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onMessageCreated(MessageCreatedEvent event) {
        mentions.notifyMentions(event.message());
    }
}
