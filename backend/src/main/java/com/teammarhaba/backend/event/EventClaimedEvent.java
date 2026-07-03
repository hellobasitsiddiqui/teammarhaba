package com.teammarhaba.backend.event;

/**
 * Domain event published when a waitlisted member successfully claims a freed spot (TM-397) — the
 * offer cascade's terminal move, raised from {@link EventRsvpService#claim}.
 *
 * <p>Published <em>in-transaction</em> so it only ever fires for a claim that truly committed
 * (WAITLISTED → GOING). The consumer ({@code EventLifecycleNotifier}) subscribes with
 * {@code @TransactionalEventListener(phase = AFTER_COMMIT)} and sends the claimant the "You're in ✓"
 * confirmation push — a rolled-back or lost claim never notifies. Deliberately raised only on a
 * genuine promotion, not on the idempotent double-tap of an already-{@code GOING} member, so a
 * repeated claim can't double-confirm.
 *
 * <p>Thin and immutable — the ids plus a heading snapshot for the push title — mirroring
 * {@link EventLifecycleEvent}. The person is carried as a plain {@code users.id}; the notifier
 * resolves them through {@code UserRepository} (which hides tombstoned accounts) rather than trusting
 * a detached entity.
 *
 * @param eventId the {@code events.id} of the claimed event
 * @param userId  the {@code users.id} of the claimant (who gets the confirmation)
 * @param heading the event heading at claim time (the push title)
 */
public record EventClaimedEvent(long eventId, long userId, String heading) {}
