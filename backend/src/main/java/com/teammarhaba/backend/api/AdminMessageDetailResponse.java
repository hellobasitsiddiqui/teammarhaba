package com.teammarhaba.backend.api;

import com.teammarhaba.backend.messaging.AdminMessage;
import java.time.Instant;

/**
 * The full detail of one sent admin-message campaign ({@code GET /api/v1/admin/messages/{id}}, TM-562,
 * epic TM-432): the wire view of a single {@link AdminMessage} campaign header <b>including its
 * {@code body}</b>. This is the by-id companion to the {@link AdminSentHistoryResponse sent-history
 * list} row — the list read is deliberately header-only (it never carries the body), so the sent-history
 * view (TM-444) fetches THIS endpoint when an admin expands a row, to finally show the actual message
 * body it sent ("open one to see the message body"). A DTO (never the JPA entity) so the HTTP contract
 * stays decoupled and reviewable in {@code openapi.json}, exactly like {@link AdminSentHistoryResponse}.
 *
 * <p>Every field is a header fact read from the append-only {@code admin_message} row (no new migration —
 * TM-441 owns the schema). It carries the same fields as the list row plus {@code body}: the full message
 * text as sent (up to ~5000 chars), which the list read omits. Scoping/gating live at the endpoint: the
 * detail is served only to the campaign's own sender ({@code findByIdAndActorUid}), so an unknown id or
 * another admin's message is a uniform {@code 404} — this DTO is only ever built for a message the caller
 * actually sent.
 *
 * @param id             the {@code admin_message} campaign id
 * @param sentAt         when the campaign was sent (DB-authoritative {@code created_at})
 * @param sentByUid      Firebase UID of the admin who sent it (always attributed)
 * @param title          the message title as sent
 * @param body           the full message body as sent (the field the list read omits; the point of TM-562)
 * @param deepLink       the optional in-app route it opened; {@code null} if none
 * @param audienceType   the single audience dimension targeted (USER | CITY | EVENT)
 * @param audienceRef    human-readable descriptor of the target audience (id CSV / city name(s))
 * @param recipientCount how many recipients the audience resolved to at send time (the reach / sent)
 * @param status         derived delivery status (SENT | EMPTY | RECALLED), shared with the list row
 * @param recalledAt     when the campaign was recalled (TM-473), or {@code null} if it is still live
 */
public record AdminMessageDetailResponse(
        long id,
        Instant sentAt,
        String sentByUid,
        String title,
        String body,
        String deepLink,
        String audienceType,
        String audienceRef,
        int recipientCount,
        String status,
        Instant recalledAt) {

    /**
     * Map a persisted {@link AdminMessage} campaign header to its full detail wire form. Reuses
     * {@link AdminSentHistoryResponse#deriveStatus} so the by-id detail and the list row can never
     * disagree on a campaign's status; the only addition over the list row is the {@code body}.
     */
    public static AdminMessageDetailResponse from(AdminMessage message) {
        return new AdminMessageDetailResponse(
                message.getId(),
                message.getCreatedAt(),
                message.getActorUid(),
                message.getTitle(),
                message.getBody(),
                message.getDeepLink(),
                message.getTargetType().name(),
                message.getTargetRef(),
                message.getRecipientCount(),
                AdminSentHistoryResponse.deriveStatus(message),
                message.getRecalledAt());
    }
}
