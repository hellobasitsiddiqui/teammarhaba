package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushNotificationService;
import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * {@link EventAttendeeNotifier} recipient rails and token fan-out (TM-397), against mocked
 * collaborators. This is the shared primitive behind the lifecycle/cancel pushes, the waitlist offer
 * cascade and the claim confirmation, so its rails (resolve through {@code User}; drop soft-deleted,
 * suspended and push-opted-out accounts) and its de-dup/order guarantees are asserted once here.
 *
 * <p>The token read is now a single batched {@link DeviceTokenRepository#findByUserIdIn} for all
 * eligible recipients rather than one {@code findByUserId} per user (TM-525): these tests pin both the
 * preserved behaviour (de-dup by value, caller-order iteration) and the batching itself (ineligible
 * users are filtered out before the read, so their tokens are never resolved).
 */
@ExtendWith(MockitoExtension.class)
class EventAttendeeNotifierTest {

    private static final Instant T0 = Instant.parse("2026-07-03T12:00:00Z");

    @Mock private UserRepository users;
    @Mock private DeviceTokenRepository deviceTokens;
    @Mock private PushNotificationService push;

    /** Device tokens per user, returned in id order by the single batched findByUserIdIn stub. */
    private final Map<Long, List<DeviceToken>> tokensByUser = new HashMap<>();

    private EventAttendeeNotifier notifier;

    @BeforeEach
    void setUp() {
        notifier = new EventAttendeeNotifier(users, deviceTokens, push);
    }

    private void stubBatchedTokenRead() {
        when(deviceTokens.findByUserIdIn(anyCollection())).thenAnswer(inv -> {
            Collection<Long> ids = inv.getArgument(0);
            List<DeviceToken> union = new ArrayList<>();
            for (Long id : ids) {
                union.addAll(tokensByUser.getOrDefault(id, List.of()));
            }
            return union;
        });
    }

    private User user(long id, NotificationPref pref, boolean enabled) {
        User u = new User("uid-" + id, "u" + id + "@example.com", null);
        setField(u, "id", id);
        u.setNotificationPref(pref);
        setField(u, "enabled", enabled);
        return u;
    }

    private void stubTokens(long userId, String... values) {
        List<DeviceToken> devices = new ArrayList<>();
        for (String v : values) {
            devices.add(new DeviceToken(userId, v, DevicePlatform.ANDROID, T0));
        }
        tokensByUser.put(userId, devices);
    }

    private static void setField(User target, String name, Object value) {
        try {
            var field = User.class.getDeclaredField(name);
            field.setAccessible(true);
            field.set(target, value);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void resolvesEligibleRecipientsThroughUserAndBatchesTheTokenRead() {
        // Recipients (in caller order): eligible(1), opted-out(2), disabled(3), tombstoned(4),
        // shared-device(5). The rails must keep only 1 and 5, and the tokens de-dup across the shared
        // value, preserving caller order.
        List<Long> recipients = List.of(1L, 2L, 3L, 4L, 5L);
        User eligible = user(1L, NotificationPref.PUSH, true);
        User optedOut = user(2L, NotificationPref.EMAIL, true);
        User disabled = user(3L, NotificationPref.BOTH, false);
        User sharer = user(5L, NotificationPref.BOTH, true);
        // findAllById resolves THROUGH the User aggregate: id 4 (tombstoned) is simply not returned.
        when(users.findAllById(recipients)).thenReturn(List.of(eligible, optedOut, disabled, sharer));
        stubTokens(1L, "tok-a", "tok-b");
        stubTokens(5L, "tok-a", "tok-c"); // tok-a shared with user 1 — must be pushed once
        stubBatchedTokenRead();
        when(push.sendToTokens(anyCollection(), any(PushMessage.class))).thenReturn(new PushFanout(3, 3, 0, 0));

        PushMessage message = new PushMessage("t", "b", "#/events/1");
        PushFanout result = notifier.pushToUsers(recipients, message);

        assertThat(result).isEqualTo(new PushFanout(3, 3, 0, 0));

        // ONE batched token read, asking only for the eligible ids in caller order.
        verify(deviceTokens).findByUserIdIn(List.of(1L, 5L));
        verify(deviceTokens, never()).findByUserId(any());

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Collection<String>> sent = ArgumentCaptor.forClass(Collection.class);
        verify(push).sendToTokens(sent.capture(), any(PushMessage.class));
        assertThat(sent.getValue()).containsExactly("tok-a", "tok-b", "tok-c");
    }

    @Test
    void emptyRecipientsIsANoOp() {
        PushFanout result = notifier.pushToUsers(Collections.emptyList(), new PushMessage("t", "b", "#/events/1"));

        assertThat(result).isEqualTo(new PushFanout(0, 0, 0, 0));
        verifyNoInteractions(users, deviceTokens, push);
    }

    @Test
    void noEligibleRecipientMeansNoTokenReadAndNoSend() {
        // The only recipient is push-opted-out, so eligibility filtering empties the set BEFORE any
        // token read — the batched query is never issued and nothing is pushed.
        when(users.findAllById(List.of(2L))).thenReturn(List.of(user(2L, NotificationPref.EMAIL, true)));

        PushFanout result = notifier.pushToUsers(List.of(2L), new PushMessage("t", "b", "#/events/1"));

        assertThat(result).isEqualTo(new PushFanout(0, 0, 0, 0));
        verify(deviceTokens, never()).findByUserIdIn(anyCollection());
        verifyNoInteractions(push);
    }
}
