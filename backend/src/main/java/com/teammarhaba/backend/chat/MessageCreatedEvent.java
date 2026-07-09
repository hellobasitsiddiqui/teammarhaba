package com.teammarhaba.backend.chat;

/**
 * Domain event published <em>in-transaction</em> the moment a chat message row is persisted, and
 * consumed {@code @TransactionalEventListener(phase = AFTER_COMMIT)} by {@link MessageCreatedPushListener}
 * (TM-579). It is the seam that moves the new-message push fan-out (TM-437) out of the write
 * transaction:
 *
 * <ul>
 *   <li><b>No phantom push on rollback.</b> Publishing is just registering interest; the listener only
 *       fires once the surrounding transaction genuinely commits. If the commit fails after the message
 *       was written, the fan-out never runs — so recipients can never get a push for a message that then
 *       disappeared (the bug this ticket fixes).</li>
 *   <li><b>The FCM network call no longer holds the write connection.</b> The fan-out runs after the
 *       transaction has committed and released its DB connection, so a slow push can't pin the writer.</li>
 * </ul>
 *
 * <p>Mirrors {@link com.teammarhaba.backend.event.EventClaimedEvent} — a thin, immutable event raised
 * inside the write path and handled post-commit by the notifier.
 *
 * <p><b>Why carry the whole {@link Message}.</b> The message is passed straight to
 * {@link NewMessageNotifier#onMessageCreated(Message)}, whose contract is unchanged. That consumer only
 * reads the message's <em>scalar</em> getters (id, conversation id, sender id, body, deep-link,
 * system/deleted flags) — never a lazy association — and those columns are all loaded at flush time, so
 * the entity is safe to carry across the commit boundary even once detached.
 *
 * @param message the just-persisted message whose creation should fan a push out after commit
 */
public record MessageCreatedEvent(Message message) {}
