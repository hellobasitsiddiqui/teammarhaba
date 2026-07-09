package com.teammarhaba.backend.api;

import com.teammarhaba.backend.messaging.AdminSendResult;

/**
 * The result of an admin send {@code POST /api/v1/admin/messages} (TM-441, epic TM-432): the campaign
 * that was created plus how it was delivered, so the compose UI (TM-443) can show an honest one-line
 * summary ("Sent to 42 people · 30 pushed · 12 not pushed").
 *
 * <p>No device tokens and no per-recipient rows are ever in this payload — a token is a sender-usable
 * credential the notify stack keeps out of responses/logs/audit, and the durable membership lives in
 * the {@code notification} rows. {@code notified} is the durable inbox rows written (which every active
 * recipient gets); {@code pushSkipped} is recipients who got the inbox row but no push (opted out of
 * push, suspended, or resolved to no active account).
 *
 * @param id             the {@code admin_message} campaign id created for this send
 * @param targetType     the single audience dimension targeted (USER | CITY | EVENT)
 * @param recipientCount how many recipients the audience resolved to at send time
 * @param notified       durable inbox notifications actually written
 * @param pushTargeted   distinct device tokens a push was attempted against (post-dedupe)
 * @param pushDelivered  tokens FCM accepted
 * @param pushPruned     tokens removed because FCM reported them unregistered/invalid
 * @param pushFailed     tokens that hit a transient/other error and were kept
 * @param pushSkipped    recipients that got the inbox row but no push
 */
public record AdminMessageResponse(
        long id,
        String targetType,
        int recipientCount,
        int notified,
        int pushTargeted,
        int pushDelivered,
        int pushPruned,
        int pushFailed,
        int pushSkipped) {

    static AdminMessageResponse from(AdminSendResult result) {
        return new AdminMessageResponse(
                result.campaignId(),
                result.targetType().name(),
                result.recipientCount(),
                result.notified(),
                result.pushTargeted(),
                result.pushDelivered(),
                result.pushPruned(),
                result.pushFailed(),
                result.pushSkipped());
    }
}
