package com.teammarhaba.backend.event;

import java.util.Set;

/**
 * Domain event published when an admin changes an event's lifecycle (TM-392): created, edited, or
 * cancelled. This is the notification seam for lifecycle pushes (TM-397), now consumed by
 * {@code EventLifecycleNotifier}.
 *
 * <p>Published <em>in-transaction</em> via {@link org.springframework.context.ApplicationEventPublisher}
 * from {@link EventAdminService}. The consumer (TM-397) subscribes with
 * {@code @TransactionalEventListener(phase = AFTER_COMMIT)} so a push only ever fires for a change
 * that actually committed — a rolled-back edit must not notify anyone.
 *
 * <p>Deliberately a thin, immutable signal — id + heading snapshot + what happened + which fields
 * moved — rather than the JPA entity: a post-commit listener resolves current recipients through the
 * repositories instead of holding a detached (possibly stale) entity.
 *
 * <p><b>{@code changedFields} (TM-397).</b> For {@link Kind#UPDATED} this carries the exact set of
 * changed field names (the same names {@link EventAdminService} records on the audit row, e.g.
 * {@code "startAt"}, {@code "locationText"}); it lets the notifier apply the "material changes only"
 * policy — a start-time/location edit notifies attendees, a description typo does not — without the
 * publisher needing to know the notification rules. Empty for {@link Kind#CREATED}/{@link
 * Kind#CANCELLED} (a cancellation is material by definition; a create has no attendees to notify).
 *
 * @param eventId       the {@code events.id} of the affected event
 * @param heading       the heading at publish time (handy for logs and notification titles)
 * @param kind          what happened to the event
 * @param changedFields for {@code UPDATED}, the names of the fields that actually changed; otherwise
 *                      empty. Never {@code null} — normalised to an immutable set on construction.
 */
public record EventLifecycleEvent(long eventId, String heading, Kind kind, Set<String> changedFields) {

    /** Normalise {@code changedFields} to a non-null, immutable set (a defensive copy). */
    public EventLifecycleEvent {
        changedFields = changedFields == null ? Set.of() : Set.copyOf(changedFields);
    }

    /**
     * Convenience for the field-diff-less transitions ({@code CREATED}/{@code CANCELLED}): publishes
     * with an empty {@code changedFields}. The {@code UPDATED} path uses the canonical constructor to
     * carry its changed-field set.
     */
    public EventLifecycleEvent(long eventId, String heading, Kind kind) {
        this(eventId, heading, kind, Set.of());
    }

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
