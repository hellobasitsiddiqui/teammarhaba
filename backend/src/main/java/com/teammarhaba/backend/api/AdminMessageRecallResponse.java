package com.teammarhaba.backend.api;

import com.teammarhaba.backend.messaging.AdminRecallResult;
import java.time.Instant;

/**
 * The result of an admin message <b>recall</b> ({@code POST /api/v1/admin/messages/{id}/recall},
 * TM-473, epic TM-432): the campaign that was recalled, when, and how many in-app copies were removed,
 * so the compose/sent UI can confirm the recall with an honest one-line summary.
 *
 * <p><b>Recall removes only the in-app copies</b> — the durable {@code ADMIN_MESSAGE} inbox/panel rows
 * (which also back the notification bell). It is <b>best-effort on push</b>: an OS-tray push that
 * already fired can't be un-sent (there is no FCM recall), so a delivered tray notification may linger
 * until the OS/user clears it. That boundary is surfaced to the admin in the recall confirm copy
 * ({@code admin-message-recall-core.js}); this payload reports the in-app reach that <em>was</em>
 * removed.
 *
 * @param id         the {@code admin_message} campaign id that was recalled
 * @param recalledAt when it was recalled (the header's {@code recalled_at})
 * @param recalledBy Firebase UID of the admin who recalled it
 * @param removed    how many durable in-app copies were <b>deleted</b> — the unseen partition (never
 *                   surfaced in the bell/panel), which vanish cleanly; {@code 0} for a re-recall of an
 *                   already-recalled message (idempotent no-op)
 * @param tombstoned how many durable in-app copies were <b>tombstoned</b> — the already-seen partition,
 *                   kept + marked recalled and rendered struck-through as "Recalled by admin"; {@code 0}
 *                   on an idempotent no-op or when nobody had seen it yet
 */
public record AdminMessageRecallResponse(
        long id, Instant recalledAt, String recalledBy, int removed, int tombstoned) {

    static AdminMessageRecallResponse from(AdminRecallResult result) {
        return new AdminMessageRecallResponse(
                result.campaignId(),
                result.recalledAt(),
                result.recalledBy(),
                result.removed(),
                result.tombstoned());
    }
}
