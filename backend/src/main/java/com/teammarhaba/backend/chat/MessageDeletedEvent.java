package com.teammarhaba.backend.chat;

import java.time.Instant;

/**
 * Domain event published <em>in-transaction</em> the moment an author soft-deletes their own chat
 * message (TM-467), and consumed {@code @TransactionalEventListener(phase = AFTER_COMMIT)} by
 * {@link MessageMutationStreamListener}. It is the seam that lets a connected member's open thread
 * drop the message live (TM-464) rather than only on their next poll — the delete sibling of
 * {@link MessageEditedEvent}.
 *
 * <p>Like the edit event, an author delete publishes ONLY this stream event — never a push. Carries
 * just the scalars the broadcast needs (the message + conversation id and the soft-delete instant),
 * not the whole {@link Message}, since the timeline is only ever <em>removing</em> the row — there is
 * no body to re-render, and the detached entity's body is deliberately not needed.
 *
 * <p><b>No phantom live drop on rollback.</b> The listener fires only after the surrounding
 * transaction commits, so a rolled-back delete broadcasts nothing.
 *
 * @param conversationId the thread the removed message belonged to (the broadcast key)
 * @param messageId      the id of the message a connected client should drop from its open thread
 * @param deletedAt      the soft-delete instant stamped on the message (first-moment-wins)
 */
public record MessageDeletedEvent(long conversationId, long messageId, Instant deletedAt) {}
