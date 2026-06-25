package com.teammarhaba.backend.notify;

import com.google.firebase.messaging.FirebaseMessaging;
import com.google.firebase.messaging.FirebaseMessagingException;
import com.google.firebase.messaging.Message;
import com.google.firebase.messaging.MessagingErrorCode;
import com.google.firebase.messaging.Notification;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The default {@link PushSender} (TM-284): delivers a notification over FCM using the shared
 * {@link FirebaseMessaging} from the Firebase Admin SDK ({@code FirebaseConfig}) — the same
 * {@code FirebaseApp} that already mints/verifies tokens, so no extra credentials are introduced.
 *
 * <p>It never throws on a delivery problem; it classifies the FCM error into a {@link PushDelivery}
 * so the {@link PushNotificationService} fan-out can prune dead tokens and continue past transient
 * failures:
 *
 * <ul>
 *   <li>{@link MessagingErrorCode#UNREGISTERED} (and a token-shaped {@code INVALID_ARGUMENT}) →
 *       {@link PushDelivery#UNREGISTERED}, so the caller prunes the token.</li>
 *   <li>any other {@link FirebaseMessagingException} → {@link PushDelivery#FAILED} (logged, token kept).</li>
 * </ul>
 *
 * <p>A real FCM transport is only swapped out in tests by registering a recording {@link PushSender}
 * bean (see {@code PushSenderConfig}'s {@code @ConditionalOnMissingBean}); production uses this one.
 */
public class FcmPushSender implements PushSender {

    private static final Logger log = LoggerFactory.getLogger(FcmPushSender.class);

    private final FirebaseMessaging messaging;

    public FcmPushSender(FirebaseMessaging messaging) {
        this.messaging = messaging;
    }

    @Override
    public PushDelivery send(String token, PushMessage message) {
        Message.Builder builder = Message.builder()
                .setToken(token)
                .setNotification(Notification.builder()
                        .setTitle(message.title())
                        .setBody(message.body())
                        .build());
        // TM-290: carry the deep-link destination in the FCM data payload so a notification tap
        // navigates the app there (read by web/src/assets/push-deeplink.js, TM-285). The route is
        // already constrained to a known hash route by PushMessage; a null route adds nothing.
        if (message.route() != null) {
            builder.putData("route", message.route());
        }
        Message fcm = builder.build();
        try {
            messaging.send(fcm);
            return PushDelivery.DELIVERED;
        } catch (FirebaseMessagingException e) {
            PushDelivery outcome = classify(e.getMessagingErrorCode());
            if (outcome == PushDelivery.UNREGISTERED) {
                // The device is unreachable for good (app uninstalled / token revoked or malformed):
                // signal a prune so we never target this token again.
                log.info("FCM reports device token unregistered; will be pruned.");
            } else {
                // Transient/other (rate limit, FCM outage, network): keep the token, the fan-out continues.
                log.warn("FCM push delivery failed (token kept): {}", e.getMessagingErrorCode(), e);
            }
            return outcome;
        }
    }

    /**
     * Map an FCM {@link MessagingErrorCode} to a {@link PushDelivery}. A token is gone for good when FCM
     * says {@code UNREGISTERED}, or when it rejects the token itself as {@code INVALID_ARGUMENT} — both
     * mean this token will never deliver and should be pruned. Anything else (including a {@code null}
     * code) is a keep-the-token failure. Package-private so the mapping is unit-testable without
     * constructing the SDK's final exception type.
     */
    static PushDelivery classify(MessagingErrorCode code) {
        if (code == MessagingErrorCode.UNREGISTERED || code == MessagingErrorCode.INVALID_ARGUMENT) {
            return PushDelivery.UNREGISTERED;
        }
        return PushDelivery.FAILED;
    }
}
