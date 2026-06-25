package com.teammarhaba.backend.notify;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.google.firebase.messaging.FirebaseMessaging;
import com.google.firebase.messaging.Message;
import com.google.firebase.messaging.MessagingErrorCode;
import java.lang.reflect.Field;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * {@link FcmPushSender} error-code mapping (TM-284): a successful send is {@code DELIVERED}, and the FCM
 * {@link MessagingErrorCode} classification routes {@code UNREGISTERED} (and a token-shaped
 * {@code INVALID_ARGUMENT}) to a prune signal while everything else keeps the token. The mapping is
 * asserted directly via the package-private {@link FcmPushSender#classify} — the SDK's exception type is
 * {@code final}, so its construction is avoided rather than mocked. No real FCM is contacted.
 *
 * <p>Also covers the deep-link wiring (TM-290): a message with a route puts {@code data.route} on the
 * outgoing FCM {@link Message}, and a message without one carries no data. The SDK's {@code Message}
 * exposes no public getter for its data map, so the built message is captured and its private
 * {@code data} field read reflectively — still no real FCM.
 */
class FcmPushSenderTest {

    private static final PushMessage MSG = new PushMessage("Title", "Body");

    @Test
    void successfulSendIsDelivered() throws Exception {
        FirebaseMessaging messaging = mock(FirebaseMessaging.class);
        when(messaging.send(any(Message.class))).thenReturn("projects/p/messages/1");

        assertThat(new FcmPushSender(messaging).send("tok", MSG)).isEqualTo(PushDelivery.DELIVERED);
    }

    @Test
    void aRouteIsSetOnTheFcmDataPayload() throws Exception {
        FirebaseMessaging messaging = mock(FirebaseMessaging.class);
        when(messaging.send(any(Message.class))).thenReturn("projects/p/messages/1");
        PushMessage withRoute = new PushMessage("Title", "Body", "#/profile");

        new FcmPushSender(messaging).send("tok", withRoute);

        ArgumentCaptor<Message> sent = ArgumentCaptor.forClass(Message.class);
        verify(messaging).send(sent.capture());
        assertThat(dataOf(sent.getValue())).containsEntry("route", "#/profile");
    }

    @Test
    void noRouteMeansNoDataOnTheFcmMessage() throws Exception {
        FirebaseMessaging messaging = mock(FirebaseMessaging.class);
        when(messaging.send(any(Message.class))).thenReturn("projects/p/messages/1");

        new FcmPushSender(messaging).send("tok", MSG); // MSG has no route

        ArgumentCaptor<Message> sent = ArgumentCaptor.forClass(Message.class);
        verify(messaging).send(sent.capture());
        assertThat(dataOf(sent.getValue())).doesNotContainKey("route");
    }

    /** Read the FCM {@link Message}'s data map (no public getter) reflectively — test-only. */
    @SuppressWarnings("unchecked")
    private static Map<String, String> dataOf(Message message) throws Exception {
        Field data = Message.class.getDeclaredField("data");
        data.setAccessible(true);
        Map<String, String> map = (Map<String, String>) data.get(message);
        return map == null ? Map.of() : map;
    }

    @Test
    void unregisteredCodeMapsToUnregistered() {
        assertThat(FcmPushSender.classify(MessagingErrorCode.UNREGISTERED))
                .isEqualTo(PushDelivery.UNREGISTERED);
    }

    @Test
    void invalidArgumentCodeAlsoMapsToUnregistered() {
        // FCM rejecting the token itself means it will never deliver — prune it.
        assertThat(FcmPushSender.classify(MessagingErrorCode.INVALID_ARGUMENT))
                .isEqualTo(PushDelivery.UNREGISTERED);
    }

    @Test
    void transientErrorMapsToFailedAndIsNotPruned() {
        assertThat(FcmPushSender.classify(MessagingErrorCode.INTERNAL)).isEqualTo(PushDelivery.FAILED);
        assertThat(FcmPushSender.classify(MessagingErrorCode.UNAVAILABLE)).isEqualTo(PushDelivery.FAILED);
        assertThat(FcmPushSender.classify(MessagingErrorCode.QUOTA_EXCEEDED)).isEqualTo(PushDelivery.FAILED);
    }

    @Test
    void nullCodeMapsToFailed() {
        assertThat(FcmPushSender.classify(null)).isEqualTo(PushDelivery.FAILED);
    }
}
