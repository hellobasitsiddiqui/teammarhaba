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
 * (recipients with at least one device attempted) and {@code skipped} (recipients not delivered to).
 * Each {@link Recipient} reuses {@link PushFanoutResponse} for its per-user fan-out so the field names
 * are identical to the single-user test-push response.
 *
 * <p><strong>Safety-rail reporting (TM-364).</strong> The {@code skippedOptedOut} /
 * {@code skippedDisabled} / {@code skippedNotFound} counters break {@code skipped} down by <em>why</em>
 * a recipient was gated (opted out of push, suspended, or absent/soft-deleted), and
 * {@code dedupedTokens} reports how many device tokens were collapsed because a shared device was
 * resolved under more than one recipient. Together they let the admin UI show exactly who was
 * intentionally NOT sent to, and why (AC8). No device tokens are ever in this payload.
 *
 * @param requested       how many user ids the request asked for
 * @param sent            recipients that had at least one device targeted
 * @param skipped         recipients not delivered to (no device, opted out, disabled, or not found)
 * @param targeted        total distinct devices attempted across all recipients (post-dedupe)
 * @param delivered       total tokens FCM accepted
 * @param pruned          total tokens removed because FCM reported them unregistered/invalid
 * @param failed          total tokens that hit a transient/other error and were kept
 * @param skippedOptedOut recipients skipped because their notification preference is not PUSH/BOTH
 * @param skippedDisabled recipients skipped because their account is suspended (disabled)
 * @param skippedNotFound recipients skipped because no active account resolved (absent or soft-deleted)
 * @param dedupedTokens   device tokens collapsed because a shared token was resolved under >1 recipient
 * @param recipients      the per-recipient outcomes, in request order
 */
public record BroadcastPushResponse(
        int requested,
        int sent,
        int skipped,
        int targeted,
        int delivered,
        int pruned,
        int failed,
        int skippedOptedOut,
        int skippedDisabled,
        int skippedNotFound,
        int dedupedTokens,
        List<Recipient> recipients) {

    /**
     * One recipient's outcome on the wire: the user id, how it resolved
     * ({@code SENT | NO_DEVICES | SKIPPED_OPTED_OUT | SKIPPED_DISABLED | SKIPPED_NOT_FOUND}), and the
     * per-user fan-out as a {@link PushFanoutResponse}.
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
                result.skippedOptedOut(),
                result.skippedDisabled(),
                result.skippedNotFound(),
                result.dedupedTokens(),
                recipients);
    }
}
