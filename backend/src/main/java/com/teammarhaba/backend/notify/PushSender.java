package com.teammarhaba.backend.notify;

/**
 * The single seam through which a push notification is delivered to one device (TM-284, epic TM-277).
 *
 * <p>This mirrors the {@code EmailCodeMailer} mail seam: the default implementation
 * ({@link FcmPushSender}) talks to FCM via the shared Firebase Admin SDK, and a future transport (or a
 * test) swaps in another bean of this type — without {@link PushNotificationService} changing. Keeping
 * it an interface (rather than calling {@code FirebaseMessaging} inline) makes that swap a one-bean
 * change and lets tests assert "these tokens were targeted" against a recording fake, with
 * <strong>no real FCM calls in tests</strong>.
 *
 * <p>Unlike the mail seam, a per-device failure here must <em>not</em> throw — a push fan-out targets
 * many tokens and one dead device must not abort the rest. So {@link #send} reports its outcome as a
 * {@link PushDelivery} value: the service prunes on {@link PushDelivery#UNREGISTERED} and logs-and-
 * continues on {@link PushDelivery#FAILED}.
 */
public interface PushSender {

    /**
     * Deliver {@code message} to the device identified by {@code token}.
     *
     * <p>Implementations must not throw for an ordinary delivery problem — they classify it into a
     * {@link PushDelivery} so the fan-out can keep going. {@link PushDelivery#UNREGISTERED} specifically
     * means the token is permanently invalid and should be pruned from the store.
     *
     * @param token   the FCM registration token of the target device
     * @param message the notification content
     * @return how the delivery resolved
     */
    PushDelivery send(String token, PushMessage message);
}
