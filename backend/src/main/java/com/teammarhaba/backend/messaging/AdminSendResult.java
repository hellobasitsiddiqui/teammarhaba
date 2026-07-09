package com.teammarhaba.backend.messaging;

/**
 * The outcome of one admin send (TM-441): the campaign that was created plus how it was delivered.
 * Returned by {@link AdminMessageService#send} and mapped straight onto the API response. Carries no
 * device tokens or per-recipient rows — a token is a sender-usable credential the notify stack keeps
 * out of responses/logs/audit, and the durable membership lives in the {@code notification} rows.
 *
 * @param campaignId     the {@code admin_message} header id created for this send
 * @param targetType     the single audience dimension targeted (USER | CITY | EVENT)
 * @param recipientCount how many recipients the audience resolved to at send time (the snapshot)
 * @param notified       durable {@code ADMIN_MESSAGE} inbox rows actually written (skips
 *                       suspended/soft-deleted accounts and any already-present row)
 * @param pushTargeted   distinct device tokens a push was attempted against (post-dedupe)
 * @param pushDelivered  tokens FCM accepted
 * @param pushPruned     tokens removed because FCM reported them unregistered/invalid
 * @param pushFailed     tokens that hit a transient/other error and were kept
 * @param pushSkipped    recipients that got the inbox row but no push (opted out of push, suspended,
 *                       or resolved to no active account)
 */
public record AdminSendResult(
        long campaignId,
        TargetType targetType,
        int recipientCount,
        int notified,
        int pushTargeted,
        int pushDelivered,
        int pushPruned,
        int pushFailed,
        int pushSkipped) {}
