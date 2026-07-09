package com.teammarhaba.backend.messaging;

import java.time.Instant;

/**
 * The outcome of an admin message <b>recall</b> ({@code POST /api/v1/admin/messages/{id}/recall},
 * TM-473, epic TM-432): the campaign that was recalled, when, by whom, and — for the HYBRID recall —
 * how many in-app copies were deleted (unseen) vs tombstoned (already seen). Returned by {@link
 * AdminMessageService#recall} and mapped to the wire form ({@code AdminMessageRecallResponse}) so the
 * entity never leaves the service boundary — the same pattern as {@link AdminSendResult} for the send.
 *
 * @param campaignId the {@code admin_message} campaign id that was recalled
 * @param recalledAt when it was recalled (the header's {@code recalled_at})
 * @param recalledBy Firebase UID of the admin who recalled it (the header's {@code recalled_by})
 * @param removed    how many durable {@code ADMIN_MESSAGE} in-app copies were <b>deleted</b> — the
 *                   <em>unseen</em> partition (never surfaced in the recipient's bell/panel), which
 *                   vanish cleanly. {@code 0} for a re-recall of an already-recalled message (idempotent
 *                   no-op) or a campaign with no unseen copies left.
 * @param tombstoned how many durable {@code ADMIN_MESSAGE} in-app copies were <b>tombstoned</b> (kept +
 *                   marked recalled) — the <em>seen</em> partition (the recipient already viewed them),
 *                   rendered struck-through as "Recalled by admin". {@code 0} on an idempotent no-op or
 *                   when nobody had seen it yet.
 */
public record AdminRecallResult(
        long campaignId, Instant recalledAt, String recalledBy, int removed, int tombstoned) {}
