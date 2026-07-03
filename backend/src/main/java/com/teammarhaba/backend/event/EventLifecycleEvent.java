package com.teammarhaba.backend.event;

/**
 * Domain event published when an admin changes an event's lifecycle (TM-392): created, edited, or
 * cancelled. This is the notification seam for lifecycle pushes (TM-397): this ticket only
 * publishes; nothing listens yet and no push logic lives here.
 *
 * <p>Published <em>in-transaction</em> via {@link org.springframework.context.ApplicationEventPublisher}
 * from {@link EventAdminService}. A future consumer (TM-397) should subscribe with
 * {@code @TransactionalEventListener(phase = AFTER_COMMIT)} so a push only ever fires for a change
 * that actually committed — a rolled-back edit must not notify anyone.
 *
 * <p>Deliberately a thin, immutable signal — id + heading snapshot + what happened — rather than
 * the JPA entity: a post-commit listener should reload current state through
 * {@link EventRepository} instead of holding a detached (possibly stale) entity.
 *
 * @param eventId the {@code events.id} of the affected event
 * @param heading the heading at publish time (handy for logs and notification titles)
 * @param kind    what happened to the event
 */
public record EventLifecycleEvent(long eventId, String heading, Kind kind) {

    /** The lifecycle transitions a listener can react to. */
    public enum Kind {
        /** A new event was created (it may not be publicly visible yet — check its window). */
        CREATED,
        /** An existing event's details changed. */
        UPDATED,
        /** The event was called off; the record remains, status {@code CANCELLED}. */
        CANCELLED
    }
}
