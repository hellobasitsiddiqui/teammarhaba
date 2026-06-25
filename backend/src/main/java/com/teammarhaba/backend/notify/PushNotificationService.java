package com.teammarhaba.backend.notify;

import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.device.DeviceTokenService;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Sends a push notification to all of a user's registered devices (TM-284, epic TM-277).
 *
 * <p>Given a user id, it reads that user's device tokens (TM-283's store) and delivers the message to
 * each through the {@link PushSender} seam — the real {@link FcmPushSender} in production, a recording
 * fake in tests. The fan-out is resilient by design:
 *
 * <ul>
 *   <li>a token FCM reports {@link PushDelivery#UNREGISTERED} is <strong>pruned</strong> via
 *       {@link DeviceTokenService#prune(String)} so it is never targeted again;</li>
 *   <li>a {@link PushDelivery#FAILED} token is logged and left in place;</li>
 *   <li>neither outcome aborts the loop — every remaining device is still attempted.</li>
 * </ul>
 *
 * <p>A user with no registered devices is a no-op (nothing to deliver). The send is deliberately
 * <em>not</em> wrapped in a single transaction: each prune is its own short write (via the device
 * service), so a later FCM hiccup can't roll back the eviction of an already-dead token.
 */
@Service
public class PushNotificationService {

    private static final Logger log = LoggerFactory.getLogger(PushNotificationService.class);

    private final DeviceTokenRepository tokens;
    private final DeviceTokenService deviceTokens;
    private final PushSender sender;

    public PushNotificationService(
            DeviceTokenRepository tokens, DeviceTokenService deviceTokens, PushSender sender) {
        this.tokens = tokens;
        this.deviceTokens = deviceTokens;
        this.sender = sender;
    }

    /**
     * Deliver {@code message} to every device registered against {@code userId} (TM-284). Prunes tokens
     * FCM reports as {@code unregistered}; logs and continues past transient failures. Returns a summary
     * of the fan-out so callers/tests can see how it resolved.
     *
     * @param userId  the {@code users.id} whose devices to notify
     * @param message the notification content
     * @return per-outcome counts for the fan-out
     */
    public PushFanout sendToUser(Long userId, PushMessage message) {
        List<DeviceToken> devices = tokens.findByUserId(userId);
        if (devices.isEmpty()) {
            log.debug("No registered devices for user {}; nothing to push.", userId);
            return PushFanout.EMPTY;
        }

        int delivered = 0;
        int pruned = 0;
        int failed = 0;
        for (DeviceToken device : devices) {
            String token = device.getToken();
            PushDelivery outcome;
            try {
                outcome = sender.send(token, message);
            } catch (RuntimeException unexpected) {
                // A seam impl should classify rather than throw, but never let one bad device abort the
                // rest of the fan-out — treat an unexpected throw as a non-pruning failure.
                log.warn("Unexpected error sending push to a device for user {} (token kept).", userId, unexpected);
                failed++;
                continue;
            }
            switch (outcome) {
                case DELIVERED -> delivered++;
                case UNREGISTERED -> {
                    if (deviceTokens.prune(token)) {
                        pruned++;
                    }
                }
                case FAILED -> failed++;
            }
        }

        PushFanout result = new PushFanout(devices.size(), delivered, pruned, failed);
        log.info("Pushed to user {}: {}", userId, result);
        return result;
    }

    /**
     * Per-outcome counts for one {@link #sendToUser} fan-out (TM-284).
     *
     * @param targeted  devices attempted (the user's registered tokens at send time)
     * @param delivered tokens FCM accepted
     * @param pruned    tokens removed because FCM reported them unregistered/invalid
     * @param failed    tokens that hit a transient/other error and were kept
     */
    public record PushFanout(int targeted, int delivered, int pruned, int failed) {
        static final PushFanout EMPTY = new PushFanout(0, 0, 0, 0);
    }
}
