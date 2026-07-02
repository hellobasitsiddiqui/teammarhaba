package com.teammarhaba.backend.api;

import com.teammarhaba.backend.notify.BroadcastResult;
import java.util.List;

/**
 * The result of an admin broadcast {@code POST /api/v1/admin/push/broadcast} (TM-363, epic TM-358):
 * the aggregate outcome across every recipient plus a per-recipient breakdown, so an admin can see at
 * a glance how the send resolved and drill into any one user.
 *
 * <p>The aggregate mirrors {@link PushFanoutResponse}'s counters ({@code targeted / delivered / pruned
 * / failed}) summed over all recipients, and adds {@code requested} (ids asked for), {@code sent}
 * (recipients with at least one device attempted) and {@code skipped} (recipients with zero devices).
 * Each {@link Recipient} reuses {@link PushFanoutResponse} for its per-user fan-out so the field names
 * are identical to the single-user test-push response.
 *
 * @param requested  how many user ids the request asked for
 * @param sent        recipients that had at least one device targeted
 * @param skipped     recipients delivered to zero devices (no device now; opted-out later, TM-364)
 * @param targeted    total devices attempted across all recipients
 * @param delivered   total tokens FCM accepted
 * @param pruned      total tokens removed because FCM reported them unregistered/invalid
 * @param failed      total tokens that hit a transient/other error and were kept
 * @param recipients  the per-recipient outcomes, in request order
 */
public record BroadcastPushResponse(
        int requested,
        int sent,
        int skipped,
        int targeted,
        int delivered,
        int pruned,
        int failed,
        List<Recipient> recipients) {

    /**
     * One recipient's outcome on the wire: the user id, how it resolved
     * ({@code SENT | NO_DEVICES | NOT_FOUND}; {@code SKIPPED_*} reserved for TM-364), and the per-user
     * fan-out as a {@link PushFanoutResponse}.
     *
     * @param userId  the {@code users.id} this result is for
     * @param outcome how the recipient resolved
     * @param fanout  the per-user device fan-out (zeros when nothing was attempted)
     */
    public record Recipient(long userId, String outcome, PushFanoutResponse fanout) {}

    static BroadcastPushResponse from(BroadcastResult result) {
        List<Recipient> recipients = result.recipients().stream()
                .map(r -> new Recipient(
                        r.userId(), r.outcome().name(), PushFanoutResponse.from(r.fanout())))
                .toList();
        return new BroadcastPushResponse(
                result.requested(),
                result.sent(),
                result.skipped(),
                result.targeted(),
                result.delivered(),
                result.pruned(),
                result.failed(),
                recipients);
    }
}
