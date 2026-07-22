package com.teammarhaba.backend.event;

/**
 * Domain event published when an admin roster op (TM-592) changes one specific attendee's spot — an
 * {@link Kind#EVICTED eviction} or a {@link Kind#ADDED force-add}. It carries the one target user who
 * must be told, so their notification fires <em>after</em> the roster write commits.
 *
 * <p><b>Why post-commit (TM-730).</b> {@link EventRosterAdminService} takes the event
 * {@code SELECT … FOR UPDATE} lock and holds a pooled DB connection for the whole op. Pushing to the
 * target in-transaction would run a per-device FCM fan-out (a synchronous network round-trip, and a
 * mid-loop {@code deviceTokens.prune} write) while that lock and connection are held — serialising
 * every concurrent RSVP/claim/cancel on the same event behind the push and tying up a connection-pool
 * slot for its duration. So the service publishes this event <em>in-transaction</em> (it only ever
 * fires for a change that truly committed) and {@link EventLifecycleNotifier} consumes it with
 * {@code @TransactionalEventListener(phase = AFTER_COMMIT)}, pushing off the event lock and the pooled
 * connection — the exact seam {@link EventClaimedEvent} already uses for the claim confirmation.
 *
 * <p>Thin and immutable — the ids plus a heading snapshot for the push title, mirroring
 * {@link EventClaimedEvent}. The target is carried as a plain {@code users.id}; the notifier resolves
 * them through {@code UserRepository} (which hides tombstoned accounts) rather than trusting a
 * detached entity.
 *
 * @param eventId the {@code events.id} of the event whose roster changed
 * @param userId  the {@code users.id} of the evicted / added target (who gets the push)
 * @param heading the event heading at write time (the push title)
 * @param kind    whether the target was {@link Kind#EVICTED} or {@link Kind#ADDED}
 */
public record EventAttendeeChangedEvent(long eventId, long userId, String heading, Kind kind) {

    /** The two admin roster moves that notify a single target. */
    public enum Kind {
        /** The target's attendance row was removed by an admin ({@code evictAttendee}). */
        EVICTED,
        /** The target was force-added GOING by an admin ({@code forceAddAttendee}). */
        ADDED
    }
}
