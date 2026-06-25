package com.teammarhaba.backend.notify;

/**
 * The outcome of attempting to deliver one {@link PushMessage} to one device token (TM-284). Returned
 * by {@link PushSender#send(String, PushMessage)} so the {@link PushNotificationService} fan-out can
 * react per token without the sender seam needing to know about the token store:
 *
 * <ul>
 *   <li>{@link #DELIVERED} — FCM accepted the message.</li>
 *   <li>{@link #UNREGISTERED} — FCM reports the token is no longer valid (uninstalled app, expired or
 *       revoked token). The caller should <strong>prune</strong> it from the store so it is never
 *       targeted again.</li>
 *   <li>{@link #FAILED} — a transient or otherwise non-fatal-to-the-token error (rate limit, FCM
 *       outage, network). The token is left in place; the caller logs and moves on to the next device.</li>
 * </ul>
 *
 * <p>Modelling the three cases as a return value (rather than throwing for {@code UNREGISTERED}) keeps
 * the prune decision in one place — the service — and lets the recording test sender drive every branch
 * deterministically with no real FCM.
 */
public enum PushDelivery {
    DELIVERED,
    UNREGISTERED,
    FAILED
}
