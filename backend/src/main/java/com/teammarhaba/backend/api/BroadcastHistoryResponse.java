package com.teammarhaba.backend.api;

import com.teammarhaba.backend.notify.NotificationBroadcast;
import java.time.Instant;

/**
 * One row in the admin push-broadcast sent-history ({@code GET /api/v1/admin/push/broadcasts},
 * TM-373, epic TM-358): the wire view of a single {@link NotificationBroadcast} header — "what push
 * did I send, to how many recipients, and when". A DTO (never the JPA entity) so the HTTP contract
 * stays decoupled from the mapping and reviewable in {@code openapi.json}, exactly like
 * {@link AdminSentHistoryResponse} (the sibling message sent-history this mirrors).
 *
 * <p>The history reads the append-only {@code notification_broadcasts} header table only (no new
 * migration — TM-359 owns the schema via {@code V10}), so every field here is a header fact:
 *
 * <ul>
 *   <li><b>title</b> → {@code title} (the push title as sent);
 *   <li><b>sent-at</b> → {@code sentAt} (the header's DB-authoritative {@code created_at}, which also
 *       drives the newest-first order);
 *   <li><b>recipient count</b> → {@code recipientCount} (the audience the broadcast resolved to at
 *       send time — the reach it targeted);
 *   <li><b>outcome counters</b> → {@code delivered} / {@code skipped} (the aggregate fan-out result
 *       already recorded on the header), so the row can show reach vs delivered without a second read.
 * </ul>
 *
 * <p>The message {@code body} and {@code route} are carried too so the row can show the full text an
 * admin sent (the broadcast header, unlike the message header, stores the body inline — there is no
 * separate by-id detail endpoint to fetch it from). Recall / AI recipient search are explicitly out of
 * scope for this MVP (TM-373 refinement) — this is a read-only list, not a recall surface.
 *
 * @param id             the {@code notification_broadcasts} header id (keys the frontend row)
 * @param sentAt         when the broadcast was sent (DB-authoritative; drives newest-first order)
 * @param title          the push title as sent
 * @param body           the push body as sent
 * @param route          the optional in-app deep-link route it opened; {@code null} if none
 * @param recipientCount how many recipients the broadcast resolved to at send time (the reach)
 * @param delivered      how many devices the broadcast successfully delivered to
 * @param skipped        how many recipients were skipped (opted out / no device / disabled / not found)
 */
public record BroadcastHistoryResponse(
        Long id,
        Instant sentAt,
        String title,
        String body,
        String route,
        int recipientCount,
        int delivered,
        int skipped) {

    /** Map a persisted {@link NotificationBroadcast} header to its sent-history wire form. */
    public static BroadcastHistoryResponse from(NotificationBroadcast broadcast) {
        return new BroadcastHistoryResponse(
                broadcast.getId(),
                broadcast.getCreatedAt(),
                broadcast.getTitle(),
                broadcast.getBody(),
                broadcast.getRoute(),
                broadcast.getRecipientCount(),
                broadcast.getDelivered(),
                broadcast.getSkipped());
    }
}
