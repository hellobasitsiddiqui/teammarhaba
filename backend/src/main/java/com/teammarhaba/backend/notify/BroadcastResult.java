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
 * (recipients that had at least one device attempted), and {@code skipped} (recipients delivered to
 * zero devices — no-device or, later, opted-out). It is what the single {@code notification_broadcasts}
 * header row and the {@code BROADCAST_SENT} audit summary are derived from.
 *
 * @param requested  how many user ids the request asked for
 * @param sent        recipients that had at least one device targeted (a real send was attempted)
 * @param skipped     recipients delivered to zero devices (no registered device, or later opted-out)
 * @param targeted    total devices attempted across all recipients
 * @param delivered   total tokens FCM accepted
 * @param pruned      total tokens removed because FCM reported them unregistered/invalid
 * @param failed      total tokens that hit a transient/other error and were kept
 * @param recipients  the per-recipient outcomes, in request order
 */
public record BroadcastResult(
        int requested,
        int sent,
        int skipped,
        int targeted,
        int delivered,
        int pruned,
        int failed,
        List<RecipientResult> recipients) {

    /**
     * One recipient's slice of a broadcast: the user id, how it resolved ({@link Outcome}), and the
     * per-user fan-out. For a missing/absent id or a user with no devices there was nothing to deliver,
     * so {@code fanout} is {@link PushFanout#EMPTY} and the outcome carries the reason.
     *
     * @param userId  the {@code users.id} this result is for
     * @param outcome how the recipient resolved
     * @param fanout  the per-user device fan-out (EMPTY when nothing was attempted)
     */
    public record RecipientResult(long userId, Outcome outcome, PushFanout fanout) {}

    /**
     * How a single recipient resolved. This task ships the base set; the safety task (TM-364) layers
     * the opt-out/dedupe filtering that produces the reserved {@code SKIPPED_*} outcomes.
     */
    public enum Outcome {
        /** The user existed and at least one device was targeted. */
        SENT,
        /** The user existed but had no registered devices — reported, not an error. */
        NO_DEVICES,
        /** No active account for this id — reported as a non-fatal per-recipient outcome, never thrown. */
        NOT_FOUND
    }
}
