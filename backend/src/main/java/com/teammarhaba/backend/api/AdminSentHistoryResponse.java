package com.teammarhaba.backend.api;

import com.teammarhaba.backend.messaging.AdminMessage;
import java.time.Instant;

/**
 * One row in the admin sent-message history ({@code GET /api/v1/admin/messages}, TM-442, epic
 * TM-432): the wire view of a single {@link AdminMessage} campaign header — "what did I send, to
 * whom, and when". A DTO (never the JPA entity) so the HTTP contract stays decoupled from the
 * mapping and reviewable in {@code openapi.json}, exactly like {@link AuditEventResponse}.
 *
 * <p>The history reads the append-only {@code admin_message} header table only (no new migration —
 * TM-441 owns the schema), so every field here is a header fact:
 *
 * <ul>
 *   <li><b>audience summary (type + count)</b> → {@code audienceType} (USER | CITY | EVENT) plus
 *       {@code recipientCount}, with {@code audienceRef} carrying the human-readable "who" descriptor
 *       (the id CSV / city name(s)) so the view can name the audience without re-resolving it;
 *   <li><b>sent-at</b> → {@code sentAt} (the header's DB-authoritative {@code created_at}, which also
 *       drives the newest-first order);
 *   <li><b>recipient count</b> → {@code recipientCount} (the audience the send resolved to at send
 *       time — the reach the campaign was durably delivered to; the durable inbox is written to every
 *       active recipient regardless of push preference, so this is the reliable "sent" figure);
 *   <li><b>delivery counts (sent / failed where available)</b> → surfaced as {@code recipientCount}
 *       (the sent reach) plus the derived {@link #status}. Per-<em>recipient</em> sent/failed tallies
 *       are deliberately <em>not</em> on the immutable, single-write header (they live on the
 *       {@code ADMIN_MESSAGE_SENT} audit row, TM-441) — so "failed" is not available from this
 *       header-only read, which is exactly the "where available" the AC allows for.
 * </ul>
 *
 * @param id             the {@code admin_message} campaign id (keys the frontend row / TM-444)
 * @param sentAt         when the campaign was sent (DB-authoritative; drives newest-first order)
 * @param sentByUid      Firebase UID of the admin who sent it (always attributed)
 * @param title          the message title as sent
 * @param deepLink       the optional in-app route it opened; {@code null} if none
 * @param audienceType   the single audience dimension targeted (USER | CITY | EVENT)
 * @param audienceRef    human-readable descriptor of the target audience (id CSV / city name(s))
 * @param recipientCount how many recipients the audience resolved to at send time (the reach / sent)
 * @param status         derived delivery status (see {@link #deriveStatus})
 */
public record AdminSentHistoryResponse(
        long id,
        Instant sentAt,
        String sentByUid,
        String title,
        String deepLink,
        String audienceType,
        String audienceRef,
        int recipientCount,
        String status) {

    /** Map a persisted {@link AdminMessage} campaign header to its sent-history wire form. */
    public static AdminSentHistoryResponse from(AdminMessage message) {
        return new AdminSentHistoryResponse(
                message.getId(),
                message.getCreatedAt(),
                message.getActorUid(),
                message.getTitle(),
                message.getDeepLink(),
                message.getTargetType().name(),
                message.getTargetRef(),
                message.getRecipientCount(),
                deriveStatus(message));
    }

    /**
     * Derive the campaign's delivery status from the recorded reach. A header row only ever exists for
     * a committed send, and an audience that resolves to nobody is rejected before the header is
     * written (TM-441) — so in practice this is always {@code SENT}. It is derived defensively from the
     * recorded {@code recipientCount} so a hypothetical zero-recipient header (never produced by the
     * send path) reads as {@code EMPTY} rather than a misleading "SENT to nobody".
     */
    static String deriveStatus(AdminMessage message) {
        return message.getRecipientCount() > 0 ? "SENT" : "EMPTY";
    }
}
