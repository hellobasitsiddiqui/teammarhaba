package com.teammarhaba.backend.notify;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.device.DeviceTokenService;
import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * {@link PushNotificationService} fan-out behaviour (TM-284), exercised entirely against the
 * {@link PushSender} seam with a recording fake — <strong>no real FCM</strong>. Covers the ACs: the
 * right tokens are targeted (all of the user's devices), an {@code UNREGISTERED} response prunes that
 * token via TM-283's store, and a per-device {@code FAILED} (or an unexpected throw) does not abort the
 * rest of the fan-out.
 */
@ExtendWith(MockitoExtension.class)
class PushNotificationServiceTest {

    private static final Long USER_ID = 42L;
    private static final PushMessage MSG = new PushMessage("Hi", "There");

    @Mock private DeviceTokenRepository tokens;
    @Mock private DeviceTokenService deviceTokens;

    private DeviceToken device(String token) {
        return new DeviceToken(USER_ID, token, DevicePlatform.ANDROID, Instant.now());
    }

    private PushNotificationService service(PushSender sender) {
        return new PushNotificationService(tokens, deviceTokens, sender);
    }

    @Test
    void targetsEveryRegisteredDeviceForTheUser() {
        when(tokens.findByUserId(USER_ID)).thenReturn(List.of(device("a"), device("b"), device("c")));
        RecordingPushSender sender = new RecordingPushSender(); // all DELIVERED by default

        PushFanout result = service(sender).sendToUser(USER_ID, MSG);

        assertThat(sender.sentTokens()).containsExactlyInAnyOrder("a", "b", "c");
        assertThat(sender.lastMessage()).isEqualTo(MSG);
        assertThat(result).isEqualTo(new PushFanout(3, 3, 0, 0));
        verify(deviceTokens, never()).prune(any());
    }

    @Test
    void unregisteredTokenIsPrunedViaTheStore() {
        when(tokens.findByUserId(USER_ID)).thenReturn(List.of(device("good"), device("dead")));
        when(deviceTokens.prune("dead")).thenReturn(true);
        RecordingPushSender sender = new RecordingPushSender()
                .outcome("good", PushDelivery.DELIVERED)
                .outcome("dead", PushDelivery.UNREGISTERED);

        PushFanout result = service(sender).sendToUser(USER_ID, MSG);

        // The dead token was still attempted (so it's in sentTokens) AND pruned; the good one is kept.
        assertThat(sender.sentTokens()).containsExactlyInAnyOrder("good", "dead");
        verify(deviceTokens).prune("dead");
        verify(deviceTokens, never()).prune("good");
        assertThat(result).isEqualTo(new PushFanout(2, 1, 1, 0));
    }

    @Test
    void perDeviceFailureDoesNotAbortTheFanout() {
        when(tokens.findByUserId(USER_ID))
                .thenReturn(List.of(device("ok1"), device("boom"), device("ok2")));
        RecordingPushSender sender = new RecordingPushSender()
                .outcome("ok1", PushDelivery.DELIVERED)
                .outcome("boom", PushDelivery.FAILED)
                .outcome("ok2", PushDelivery.DELIVERED);

        PushFanout result = service(sender).sendToUser(USER_ID, MSG);

        // Every device was attempted despite the middle one failing; a FAILED token is NOT pruned.
        assertThat(sender.sentTokens()).containsExactly("ok1", "boom", "ok2");
        assertThat(result).isEqualTo(new PushFanout(3, 2, 0, 1));
        verify(deviceTokens, never()).prune(any());
    }

    @Test
    void unexpectedSenderThrowIsTreatedAsFailureAndDoesNotAbort() {
        when(tokens.findByUserId(USER_ID)).thenReturn(List.of(device("a"), device("throws"), device("c")));
        PushSender sender = (token, message) -> {
            if (token.equals("throws")) {
                throw new RuntimeException("seam blew up");
            }
            return PushDelivery.DELIVERED;
        };

        PushFanout result = service(sender).sendToUser(USER_ID, MSG);

        // The throwing device is counted as a failure (not pruned), the other two still delivered.
        assertThat(result).isEqualTo(new PushFanout(3, 2, 0, 1));
        verify(deviceTokens, never()).prune(any());
    }

    @Test
    void unregisteredPruneNoOpDoesNotCountAsPruned() {
        // store reports the token wasn't there to remove (already gone) — don't double-count it.
        when(tokens.findByUserId(USER_ID)).thenReturn(List.of(device("dead")));
        when(deviceTokens.prune("dead")).thenReturn(false);
        RecordingPushSender sender = new RecordingPushSender().outcome("dead", PushDelivery.UNREGISTERED);

        PushFanout result = service(sender).sendToUser(USER_ID, MSG);

        assertThat(result).isEqualTo(new PushFanout(1, 0, 0, 0));
    }

    @Test
    void userWithNoDevicesIsANoOp() {
        when(tokens.findByUserId(USER_ID)).thenReturn(List.of());
        RecordingPushSender sender = new RecordingPushSender();

        PushFanout result = service(sender).sendToUser(USER_ID, MSG);

        assertThat(result).isEqualTo(new PushFanout(0, 0, 0, 0));
        assertThat(sender.sentTokens()).isEmpty();
        verifyNoInteractions(deviceTokens);
    }

    /**
     * A recording {@link PushSender} test double — the no-FCM stand-in for the real {@link FcmPushSender}.
     * It records every token it was asked to send to (in order) and returns a per-token outcome (default
     * {@link PushDelivery#DELIVERED}), so a test can drive each branch of the fan-out deterministically.
     */
    static final class RecordingPushSender implements PushSender {
        private final List<String> sent = new ArrayList<>();
        private final Map<String, PushDelivery> outcomes = new ConcurrentHashMap<>();
        private PushMessage lastMessage;

        RecordingPushSender outcome(String token, PushDelivery outcome) {
            outcomes.put(token, outcome);
            return this;
        }

        @Override
        public PushDelivery send(String token, PushMessage message) {
            sent.add(token);
            lastMessage = message;
            return outcomes.getOrDefault(token, PushDelivery.DELIVERED);
        }

        List<String> sentTokens() {
            return sent;
        }

        PushMessage lastMessage() {
            return lastMessage;
        }
    }
}
