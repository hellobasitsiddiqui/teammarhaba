package com.teammarhaba.backend.notify;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.notify.BroadcastResult.Outcome;
import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.BadRequestException;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * {@link BroadcastService} fan-out + aggregation + persistence behaviour (TM-363), exercised against
 * mocked collaborators — the real fan-out mechanics ({@link PushNotificationService}) are covered by
 * {@link PushNotificationServiceTest}, so here we stub {@code sendToUser} and assert this service's own
 * rules: route validated once up-front (off-list → 400 before any send), one {@link PushMessage} reused
 * across recipients, per-recipient outcomes, aggregate counters, a missing id reported not thrown, and
 * exactly one broadcast header + one {@code BROADCAST_SENT} audit row written with token-free metadata.
 */
@ExtendWith(MockitoExtension.class)
class BroadcastServiceTest {

    private static final String ACTOR = "admin-uid";

    @Mock private UserRepository users;
    @Mock private PushNotificationService push;
    @Mock private NotificationBroadcastRepository broadcasts;
    @Mock private AuditService audit;

    private BroadcastService service() {
        return new BroadcastService(users, push, broadcasts, audit);
    }

    /** A saved header row whose id can be read back (as the real repo returns after insert). */
    private void stubHeaderSaveReturningId(long id) {
        NotificationBroadcast saved =
                new NotificationBroadcast(ACTOR, "t", "b", null, 0, 0, 0, 0, 0, 0);
        setId(saved, id);
        when(broadcasts.save(any(NotificationBroadcast.class))).thenReturn(saved);
    }

    private static void setId(NotificationBroadcast broadcast, long id) {
        try {
            var field = NotificationBroadcast.class.getDeclaredField("id");
            field.setAccessible(true);
            field.set(broadcast, id);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    private User user(long id) {
        User u = new User("uid-" + id, "u" + id + "@example.com", null);
        try {
            var field = User.class.getDeclaredField("id");
            field.setAccessible(true);
            field.set(u, id);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
        return u;
    }

    @Test
    void offListRouteIs400BeforeAnySendOrWrite() {
        assertThatThrownBy(() ->
                        service().broadcast(ACTOR, List.of(1L), "Title", "Body", "#/evil"))
                .isInstanceOf(BadRequestException.class)
                .hasMessageContaining("Unknown push route");

        // Nothing was sent, and no header/audit rows were written — the route guard is up-front.
        verifyNoInteractions(push, broadcasts, audit);
        verify(users, never()).findById(any());
    }

    @Test
    void fansOneMessageToEveryResolvedRecipientAndAggregates() {
        when(users.findById(1L)).thenReturn(Optional.of(user(1L)));
        when(users.findById(2L)).thenReturn(Optional.of(user(2L)));
        when(push.sendToUser(eq(1L), any())).thenReturn(new PushFanout(2, 2, 0, 0));
        when(push.sendToUser(eq(2L), any())).thenReturn(new PushFanout(1, 0, 0, 1));
        stubHeaderSaveReturningId(77L);

        BroadcastResult result =
                service().broadcast(ACTOR, List.of(1L, 2L), "Title", "Body", "#/home");

        // The same message instance is reused across recipients (one build, not per-user).
        ArgumentCaptor<PushMessage> msg = ArgumentCaptor.forClass(PushMessage.class);
        verify(push).sendToUser(eq(1L), msg.capture());
        verify(push).sendToUser(eq(2L), msg.capture());
        assertThat(msg.getAllValues()).allSatisfy(m -> {
            assertThat(m.title()).isEqualTo("Title");
            assertThat(m.body()).isEqualTo("Body");
            assertThat(m.route()).isEqualTo("#/home");
        });

        assertThat(result.requested()).isEqualTo(2);
        assertThat(result.sent()).isEqualTo(2);
        assertThat(result.skipped()).isZero();
        assertThat(result.targeted()).isEqualTo(3);
        assertThat(result.delivered()).isEqualTo(2);
        assertThat(result.failed()).isEqualTo(1);
        assertThat(result.recipients())
                .extracting(BroadcastResult.RecipientResult::outcome)
                .containsExactly(Outcome.SENT, Outcome.SENT);
    }

    @Test
    void missingIdIsReportedNotFatalAndUserWithNoDevicesIsNoDevices() {
        when(users.findById(1L)).thenReturn(Optional.of(user(1L)));
        when(users.findById(2L)).thenReturn(Optional.empty()); // absent / soft-deleted
        when(push.sendToUser(eq(1L), any())).thenReturn(PushFanout.EMPTY); // resolved but no devices
        stubHeaderSaveReturningId(5L);

        BroadcastResult result = service().broadcast(ACTOR, List.of(1L, 2L), "T", "B", null);

        assertThat(result.recipients())
                .extracting(BroadcastResult.RecipientResult::userId,
                        BroadcastResult.RecipientResult::outcome)
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple(1L, Outcome.NO_DEVICES),
                        org.assertj.core.groups.Tuple.tuple(2L, Outcome.NOT_FOUND));
        assertThat(result.requested()).isEqualTo(2);
        assertThat(result.sent()).isZero();
        assertThat(result.skipped()).isEqualTo(2); // one no-device + one not-found
        // The absent id was never sent to.
        verify(push, never()).sendToUser(eq(2L), any());
    }

    @Test
    void writesExactlyOneHeaderAndOneAuditRowWithTokenFreeMetadata() {
        when(users.findById(1L)).thenReturn(Optional.of(user(1L)));
        when(push.sendToUser(eq(1L), any())).thenReturn(new PushFanout(1, 1, 0, 0));
        stubHeaderSaveReturningId(99L);

        service().broadcast(ACTOR, List.of(1L), "Hello", "World", "#/profile");

        // One header row with the sent title/body/route + aggregate counters.
        ArgumentCaptor<NotificationBroadcast> header =
                ArgumentCaptor.forClass(NotificationBroadcast.class);
        verify(broadcasts).save(header.capture());
        NotificationBroadcast row = header.getValue();
        assertThat(row.getActorUid()).isEqualTo(ACTOR);
        assertThat(row.getTitle()).isEqualTo("Hello");
        assertThat(row.getBody()).isEqualTo("World");
        assertThat(row.getRoute()).isEqualTo("#/profile");
        assertThat(row.getRecipientCount()).isEqualTo(1);
        assertThat(row.getDelivered()).isEqualTo(1);

        // One audit summary keyed to the saved header id, carrying counts/title/route — never tokens.
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> meta = ArgumentCaptor.forClass(Map.class);
        verify(audit).record(eq(ACTOR), eq(AuditAction.BROADCAST_SENT), eq("Broadcast"), eq("99"), meta.capture());
        assertThat(meta.getValue())
                .containsEntry("recipientCount", 1)
                .containsEntry("title", "Hello")
                .containsEntry("route", "#/profile")
                .containsEntry("delivered", 1);
        assertThat(meta.getValue().values())
                .noneSatisfy(v -> assertThat(String.valueOf(v)).contains("token"));
    }

    @Test
    void nullRouteWritesEmptyRouteInAuditAndNoRouteOnHeader() {
        when(users.findById(1L)).thenReturn(Optional.of(user(1L)));
        when(push.sendToUser(eq(1L), any())).thenReturn(new PushFanout(1, 1, 0, 0));
        stubHeaderSaveReturningId(1L);

        service().broadcast(ACTOR, List.of(1L), "T", "B", null);

        ArgumentCaptor<NotificationBroadcast> header =
                ArgumentCaptor.forClass(NotificationBroadcast.class);
        verify(broadcasts).save(header.capture());
        assertThat(header.getValue().getRoute()).isNull();

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> meta = ArgumentCaptor.forClass(Map.class);
        verify(audit).record(anyString(), eq(AuditAction.BROADCAST_SENT), anyString(), anyString(), meta.capture());
        assertThat(meta.getValue()).containsEntry("route", "");
    }
}
