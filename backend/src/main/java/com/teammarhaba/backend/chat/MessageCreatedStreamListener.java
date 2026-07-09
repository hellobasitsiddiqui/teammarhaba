package com.teammarhaba.backend.chat;

import com.teammarhaba.backend.api.ConversationMessageResponse;
import java.util.List;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/**
 * Broadcasts a newly-created chat message over SSE <em>after</em> the message-write transaction commits
 * (TM-464, the live-while-online transport). This is the live sibling of {@link MessageCreatedPushListener}
 * (the offline / store-and-forward push): both subscribe to the same in-transaction
 * {@link MessageCreatedEvent} that {@link MessagePostService#post} publishes, and both fire only
 * {@code @TransactionalEventListener(phase = AFTER_COMMIT)}, so the two live/offline fan-outs stay
 * symmetric and share one seam.
 *
 * <p>Firing off the post-commit event (rather than in-line inside {@code post()}) buys the same two
 * properties the push listener gets from TM-579, applied to the live path:
 *
 * <ul>
 *   <li><b>No phantom live frame on rollback.</b> {@code AFTER_COMMIT} runs only when the surrounding
 *       transaction genuinely commits. If the write rolls back (a failure after the message row was
 *       persisted), this listener never runs — so a connected member is never told over the socket about
 *       a message that then disappeared. A rolled-back post therefore fires <em>neither</em> a push
 *       <em>nor</em> an SSE broadcast.</li>
 *   <li><b>The SSE send is off the write path.</b> By the time this runs the write transaction has
 *       committed and released its DB connection, so the broadcast (and any slow client write inside it)
 *       can't pin the writer.</li>
 * </ul>
 *
 * <p>The broadcast payload is rebuilt from the just-persisted {@link Message} exactly as the poster's own
 * HTTP response is ({@link ConversationMessageResponse#from} with an empty reaction summary — a brand-new
 * message has no reactions yet), so the wire shape a live subscriber receives can never diverge from what
 * the poster got back. {@code from} reads only the message's scalar columns (all loaded at flush time),
 * so the entity is safe to map even though it is detached across the commit boundary.
 *
 * <p>{@link ChatStreamService#broadcast} is itself best-effort and single-instance: it delivers to any
 * stream open for this thread <em>on this instance</em> and returns 0 when none are (the common case, or
 * when the post landed on a different Cloud Run instance than the subscriber). A member not reached live
 * still gets the push and re-syncs over the read API on reconnect, so a missed live frame is never lossy
 * — see {@link ChatStreamService} for the cross-instance caveat (deferred to TM-505).
 */
@Component
public class MessageCreatedStreamListener {

    private final ChatStreamService stream;

    public MessageCreatedStreamListener(ChatStreamService stream) {
        this.stream = stream;
    }

    /**
     * Post-commit hook: broadcast the new message live to members currently connected to its thread's SSE
     * stream. Runs only after the write transaction committed, so a rolled-back message is never
     * broadcast, and the SSE send does not hold the write connection.
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onMessageCreated(MessageCreatedEvent event) {
        Message message = event.message();
        ConversationMessageResponse payload = ConversationMessageResponse.from(message, List.of());
        stream.broadcast(message.getConversationId(), ChatStreamService.EVENT_MESSAGE, payload);
    }
}
