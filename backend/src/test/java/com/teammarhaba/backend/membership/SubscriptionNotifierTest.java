package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import com.teammarhaba.backend.notify.NotificationType;
import com.teammarhaba.backend.notify.NotificationWriter;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushNotificationService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * The subscription lifecycle notifications (TM-620): each billing event writes the durable inbox row
 * (typed, idempotent by sourceRef) AND fires the best-effort push, both deep-linking to the membership
 * screen — and a notification failure is swallowed, never allowed to poison the billing transaction
 * that triggered it.
 */
class SubscriptionNotifierTest {

    private PushNotificationService push;
    private NotificationWriter writer;
    private SubscriptionNotifier notifier;

    @BeforeEach
    void setUp() {
        push = mock(PushNotificationService.class);
        writer = mock(NotificationWriter.class);
        notifier = new SubscriptionNotifier(push, writer);
    }

    @Test
    void startedWritesInboxRowAndPushesWithMembershipDeepLink() {
        notifier.subscriptionStarted(42L, MembershipTier.MONTHLY, "subscription:42:started:t0");

        ArgumentCaptor<PushMessage> message = ArgumentCaptor.forClass(PushMessage.class);
        verify(writer)
                .writeSystemToUser(
                        eq(NotificationType.SUBSCRIPTION_STARTED),
                        eq(42L),
                        message.capture(),
                        eq("subscription:42:started:t0"));
        assertThat(message.getValue().route()).isEqualTo("#/membership");
        assertThat(message.getValue().body()).contains("Monthly");
        verify(push).sendToUser(eq(42L), any(PushMessage.class));
    }

    @Test
    void renewalSucceededAndFailedCarryTheirTypes() {
        notifier.renewalSucceeded(42L, MembershipTier.DIAMOND, "subscription:42:renewed:t1");
        verify(writer)
                .writeSystemToUser(
                        eq(NotificationType.SUBSCRIPTION_RENEWED), eq(42L), any(PushMessage.class), anyString());

        notifier.renewalFailed(42L, MembershipTier.DIAMOND, "subscription:42:dunning:1");
        ArgumentCaptor<PushMessage> message = ArgumentCaptor.forClass(PushMessage.class);
        verify(writer)
                .writeSystemToUser(
                        eq(NotificationType.SUBSCRIPTION_PAYMENT_FAILED), eq(42L), message.capture(), anyString());
        assertThat(message.getValue().body()).contains("retry");
    }

    @Test
    void endedCopyDistinguishesDunningFromANormalEnd() {
        notifier.subscriptionEnded(42L, MembershipTier.MONTHLY, true, "subscription:42:ended:a");
        notifier.subscriptionEnded(42L, MembershipTier.MONTHLY, false, "subscription:42:ended:b");

        ArgumentCaptor<PushMessage> messages = ArgumentCaptor.forClass(PushMessage.class);
        verify(writer, org.mockito.Mockito.times(2))
                .writeSystemToUser(
                        eq(NotificationType.SUBSCRIPTION_ENDED), eq(42L), messages.capture(), anyString());
        assertThat(messages.getAllValues().get(0).body()).contains("couldn't take"); // dunning lapse
        assertThat(messages.getAllValues().get(1).body()).contains("has ended"); // cancel reached period end
    }

    @Test
    void notificationFailuresAreSwallowedNotThrown() {
        // A broken inbox write AND a broken push must never fail the billing transaction.
        doThrow(new RuntimeException("inbox down"))
                .when(writer)
                .writeSystemToUser(any(), anyLong(), any(), anyString());
        doThrow(new RuntimeException("fcm down")).when(push).sendToUser(anyLong(), any());

        notifier.renewalFailed(42L, MembershipTier.MONTHLY, "subscription:42:dunning:2"); // must not throw
    }
}
