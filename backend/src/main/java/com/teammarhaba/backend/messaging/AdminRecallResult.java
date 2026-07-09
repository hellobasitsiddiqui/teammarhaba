package com.teammarhaba.backend.messaging;

import java.time.Instant;

/**
 * The outcome of an admin message <b>recall</b> ({@code POST /api/v1/admin/messages/{id}/recall},
 * TM-473, epic TM-432): the campaign that was recalled, when, by whom, and how many in-app copies were
 * removed. Returned by {@link AdminMessageService#recall} and mapped to the wire form
 * ({@code AdminMessageRecallResponse}) so the entity never leaves the service boundary — the same
 * pattern as {@link AdminSendResult} for the send path.
 *
 * @param campaignId the {@code admin_message} campaign id that was recalled
 * @param recalledAt when it was recalled (the header's {@code recalled_at})
 * @param recalledBy Firebase UID of the admin who recalled it (the header's {@code recalled_by})
 * @param removed    how many durable {@code ADMIN_MESSAGE} in-app copies were deleted (the recall's
 *                   reach — inbox/panel rows, which also back the bell). {@code 0} for a re-recall of an
 *                   already-recalled message (idempotent no-op) or a campaign whose rows were already
 *                   purged/read-cleared.
 */
public record AdminRecallResult(long campaignId, Instant recalledAt, String recalledBy, int removed) {}
