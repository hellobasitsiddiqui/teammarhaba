package com.teammarhaba.backend.notify;

import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
import java.util.List;

/**
 * The outcome of one admin broadcast fan-out (TM-363, epic TM-358): the aggregate counters plus a
 * per-recipient breakdown. Transport-neutral (no HTTP/JSON here) so {@code BroadcastService} can
 * return it and the {@code api} layer maps it onto the wire ({@code BroadcastPushResponse}), exactly
 * as {@code PushFanout} is mapped by {@code PushFanoutResponse}.
 *
 * <p>The aggregate is the element-wise sum of every recipient's {@link PushFanout} (targeted /
 * delivered / pruned / failed) plus {@code requested} (how many ids were asked for), {@code sent}
 * (recipients that had at least one device attempted) and {@code skipped} (recipients that were
 * <em>not</em> delivered to — no device, or, from TM-364, filtered out by a safety rail). It is what
 * the single {@code notification_broadcasts} header row and the {@code BROADCAST_SENT} audit summary
 * are derived from.
 *
 * <p><strong>Safety rails (TM-364).</strong> The {@code skippedOptedOut} / {@code skippedDisabled} /
 * {@code skippedNotFound} counters break {@code skipped} down by <em>why</em> a recipient was gated
 * (opted out of push, suspended account, or absent/soft-deleted), and {@code dedupedTokens} reports
 * how many device tokens were collapsed because the same physical device (a shared/handed-down token)
 * was resolved under more than one selected recipient — it is pushed once, not per-recipient. These
 * feed the admin-visible "who we intentionally did NOT send to, and why" summary (AC8).
 *
 * @param requested       how many user ids the request asked for
 * @param sent            recipients that had at least one device targeted (a real send was attempted)
 * @param skipped         recipients not delivered to (no device, opted out, disabled, or not found)
 * @param targeted        total <em>distinct</em> devices attempted across all recipients (post-dedupe)
 * @param delivered       total tokens FCM accepted
 * @param pruned          total tokens removed because FCM reported them unregistered/invalid
 * @param failed          total tokens that hit a transient/other error and were kept
 * @param skippedOptedOut recipients skipped because their {@code notificationPref} is not PUSH/BOTH
 * @param skippedDisabled recipients skipped because their account is {@code !enabled} (suspended)
 * @param skippedNotFound recipients skipped because no active account resolved (absent or soft-deleted)
 * @param dedupedTokens   device tokens collapsed because a shared token was resolved under >1 recipient
 * @param recipients      the per-recipient outcomes, in request order
 */
public record BroadcastResult(
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
        List<RecipientResult> recipients) {

    /**
     * One recipient's slice of a broadcast: the user id, how it resolved ({@link Outcome}), and the
     * per-user fan-out. For a missing/absent id, a user with no devices, or a user filtered out by a
     * safety rail there was nothing (new) to deliver, so {@code fanout} is {@link PushFanout#EMPTY} and
     * the outcome carries the reason. For a delivered recipient the fanout counts <em>that recipient's
     * own, not-already-sent</em> tokens (a token shared with an earlier recipient is counted once,
     * against that earlier recipient — see {@code dedupedTokens}).
     *
     * @param userId  the {@code users.id} this result is for
     * @param outcome how the recipient resolved
     * @param fanout  the per-user device fan-out (EMPTY when nothing was attempted)
     */
    public record RecipientResult(long userId, Outcome outcome, PushFanout fanout) {}

    /**
     * How a single recipient resolved. TM-363 shipped the base set ({@link #SENT} / {@link #NO_DEVICES});
     * the safety task (TM-364) layers the opt-out / skip-disabled / not-found filtering that produces the
     * {@code SKIPPED_*} outcomes, so an admin sees not just <em>that</em> a recipient was skipped but
     * <em>why</em>.
     */
    public enum Outcome {
        /** The user existed, was eligible, and at least one (not-already-sent) device was targeted. */
        SENT,
        /** The user existed and was eligible but had no registered devices — reported, not an error. */
        NO_DEVICES,
        /** No active account for this id (absent or soft-deleted) — reported, never thrown. */
        SKIPPED_NOT_FOUND,
        /** The account is suspended ({@code enabled == false}) — gated by the broadcast service. */
        SKIPPED_DISABLED,
        /** The account opted out of push ({@code notificationPref} not PUSH/BOTH) — filtered out. */
        SKIPPED_OPTED_OUT
    }
}
