package com.teammarhaba.backend.chat;

/**
 * Domain event published <em>in-transaction</em> the moment an author edits their own chat message
 * (TM-467), and consumed {@code @TransactionalEventListener(phase = AFTER_COMMIT)} by
 * {@link MessageMutationStreamListener}. It is the seam that fires the live re-render (TM-464) off the
 * edit write — the edit sibling of {@link MessageCreatedEvent}.
 *
 * <p>Unlike a fresh post, an edit publishes ONLY this stream event — never the push fan-out
 * ({@link MessageCreatedEvent} is what {@link MessageCreatedPushListener} listens to). Editing a typo
 * must not re-notify the thread; it just live-re-renders for members already looking at it.
 *
 * <ul>
 *   <li><b>No phantom live re-render on rollback.</b> The listener only fires once the surrounding
 *       transaction genuinely commits, so a rolled-back edit broadcasts nothing.</li>
 *   <li><b>The SSE send is off the write path</b> (after commit), so it never holds the write
 *       connection.</li>
 * </ul>
 *
 * <p><b>Why carry the whole {@link Message}.</b> The broadcast payload is rebuilt from the just-edited
 * message exactly as the read DTO is; the listener reads only the message's scalar getters (id,
 * conversation id, body, edited-at, …), all loaded at flush time, so the entity is safe to carry
 * across the commit boundary even once detached.
 *
 * @param message the just-edited message whose new body should re-render live after commit
 */
public record MessageEditedEvent(Message message) {}
