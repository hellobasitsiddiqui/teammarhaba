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
import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.notify.BroadcastResult.Outcome;
import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.BadRequestException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * {@link BroadcastService} fan-out + safety-rail + aggregation + persistence behaviour (TM-363 base,
 * TM-364 rails), exercised against mocked collaborators — the real fan-out mechanics
 * ({@link PushNotificationService}) are covered by {@link PushNotificationServiceTest}, so here we stub
 * {@code sendToTokens} and assert this service's own rules: route validated once up-front (off-list →
 * 400 before any send), one {@link PushMessage} reused across recipients, per-recipient outcomes, the
 * TM-364 rails (opt-out / disabled / not-found skipped, shared token de-duplicated once, empty list →
 * 400, per-admin cooldown), and exactly one broadcast header + one {@code BROADCAST_SENT} audit row
 * written with the token-free, skip-broken-down metadata.
 */
@ExtendWith(MockitoExtension.class)
class BroadcastServiceTest {

    private static final String ACTOR = "admin-uid";
    private static final Instant T0 = Instant.parse("2026-01-01T00:00:00Z");

    @Mock private UserRepository users;
    @Mock private DeviceTokenRepository deviceTokens;
    @Mock private PushNotificationService push;
    @Mock private NotificationBroadcastRepository broadcasts;
    @Mock private AuditService audit;

    private final MutableClock clock = new MutableClock(T0);

    private BroadcastService service() {
        return new BroadcastService(users, deviceTokens, push, broadcasts, audit, clock);
    }

    /** A saved header row whose id can be read back (as the real repo returns after insert). */
    private void stubHeaderSaveReturningId(long id) {
        NotificationBroadcast saved =
                new NotificationBroadcast(ACTOR, "t", "b", null, 0, 0, 0, 0, 0, 0);
        setId(saved, id);
        when(broadcasts.save(any(NotificationBroadcast.class))).thenReturn(saved);
    }

    private static void setId(NotificationBroadcast broadcast, long id) {
        setField(NotificationBroadcast.class, broadcast, "id", id);
    }

    /** An enabled account with the given id and notification preference. */
    private User user(long id, NotificationPref pref) {
        User u = new User("uid-" + id, "u" + id + "@example.com", null);
        setField(User.class, u, "id", id);
        u.setNotificationPref(pref);
        return u;
    }

    /** An enabled, PUSH-eligible account (the common "will receive" case). */
    private User user(long id) {
        return user(id, NotificationPref.PUSH);
    }

    /** A PUSH-eligible but suspended (enabled == false) account. */
    private User disabledUser(long id) {
        User u = user(id, NotificationPref.PUSH);
        setField(User.class, u, "enabled", false);
        return u;
    }

    private static void setField(Class<?> type, Object target, String name, Object value) {
        try {
            var field = type.getDeclaredField(name);
            field.setAccessible(true);
            field.set(target, value);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    private void stubTokens(long userId, String... tokenValues) {
        List<DeviceToken> devices = new ArrayList<>();
        for (String t : tokenValues) {
            devices.add(new DeviceToken(userId, t, DevicePlatform.ANDROID, T0));
        }
        when(deviceTokens.findByUserId(userId)).thenReturn(devices);
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
    void emptyRecipientListIs400BeforeAnythingElse() {
        assertThatThrownBy(() -> service().broadcast(ACTOR, List.of(), "Title", "Body", null))
                .isInstanceOf(BadRequestException.class)
                .hasMessageContaining("at least one recipient");

        verifyNoInteractions(users, deviceTokens, push, broadcasts, audit);
    }

    @Test
    void fansOneMessageToEveryResolvedRecipientAndAggregates() {
        when(users.findById(1L)).thenReturn(Optional.of(user(1L)));
        when(users.findById(2L)).thenReturn(Optional.of(user(2L)));
        stubTokens(1L, "a1", "a2");
        stubTokens(2L, "b1");
        when(push.sendToTokens(eq(List.of("a1", "a2")), any())).thenReturn(new PushFanout(2, 2, 0, 0));
        when(push.sendToTokens(eq(List.of("b1")), any())).thenReturn(new PushFanout(1, 0, 0, 1));
        stubHeaderSaveReturningId(77L);

        BroadcastResult result =
                service().broadcast(ACTOR, List.of(1L, 2L), "Title", "Body", "#/home");

        // The same message content is used across recipients (one build, not per-user).
        ArgumentCaptor<PushMessage> msg = ArgumentCaptor.forClass(PushMessage.class);
        verify(push).sendToTokens(eq(List.of("a1", "a2")), msg.capture());
        verify(push).sendToTokens(eq(List.of("b1")), msg.capture());
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
        assertThat(result.dedupedTokens()).isZero();
        assertThat(result.recipients())
                .extracting(BroadcastResult.RecipientResult::outcome)
                .containsExactly(Outcome.SENT, Outcome.SENT);
    }

    @Test
    void optedOutRecipientIsSkippedAndNeverSent() {
        // EMAIL (the default) is the push opt-out; BOTH is eligible.
        when(users.findById(1L)).thenReturn(Optional.of(user(1L, NotificationPref.EMAIL)));
        when(users.findById(2L)).thenReturn(Optional.of(user(2L, NotificationPref.BOTH)));
        stubTokens(2L, "b1");
        when(push.sendToTokens(eq(List.of("b1")), any())).thenReturn(new PushFanout(1, 1, 0, 0));
        stubHeaderSaveReturningId(1L);

        BroadcastResult result = service().broadcast(ACTOR, List.of(1L, 2L), "T", "B", null);

        assertThat(result.recipients())
                .extracting(BroadcastResult.RecipientResult::userId,
                        BroadcastResult.RecipientResult::outcome)
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple(1L, Outcome.SKIPPED_OPTED_OUT),
                        org.assertj.core.groups.Tuple.tuple(2L, Outcome.SENT));
        assertThat(result.skippedOptedOut()).isEqualTo(1);
        assertThat(result.skipped()).isEqualTo(1);
        assertThat(result.sent()).isEqualTo(1);
        // The opted-out user's tokens were never even resolved, let alone sent.
        verify(deviceTokens, never()).findByUserId(1L);
    }

    @Test
    void disabledRecipientIsSkipped() {
        when(users.findById(1L)).thenReturn(Optional.of(disabledUser(1L)));
        stubHeaderSaveReturningId(1L);

        BroadcastResult result = service().broadcast(ACTOR, List.of(1L), "T", "B", null);

        assertThat(result.recipients())
                .extracting(BroadcastResult.RecipientResult::outcome)
                .containsExactly(Outcome.SKIPPED_DISABLED);
        assertThat(result.skippedDisabled()).isEqualTo(1);
        assertThat(result.skipped()).isEqualTo(1);
        assertThat(result.sent()).isZero();
        verify(deviceTokens, never()).findByUserId(1L);
        verify(push, never()).sendToTokens(any(), any());
    }

    @Test
    void notFoundRecipientIsReportedNotFatalAndEligibleWithNoDevicesIsNoDevices() {
        when(users.findById(1L)).thenReturn(Optional.of(user(1L)));
        when(users.findById(2L)).thenReturn(Optional.empty()); // absent / soft-deleted
        stubTokens(1L); // resolved + eligible but zero devices — nothing to send, sender not called
        stubHeaderSaveReturningId(5L);

        BroadcastResult result = service().broadcast(ACTOR, List.of(1L, 2L), "T", "B", null);

        assertThat(result.recipients())
                .extracting(BroadcastResult.RecipientResult::userId,
                        BroadcastResult.RecipientResult::outcome)
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple(1L, Outcome.NO_DEVICES),
                        org.assertj.core.groups.Tuple.tuple(2L, Outcome.SKIPPED_NOT_FOUND));
        assertThat(result.requested()).isEqualTo(2);
        assertThat(result.sent()).isZero();
        assertThat(result.skipped()).isEqualTo(2); // one no-device + one not-found
        assertThat(result.skippedNotFound()).isEqualTo(1);
        // The absent id's tokens were never resolved (no leak through the retained-tokens path).
        verify(deviceTokens, never()).findByUserId(2L);
    }

    @Test
    void sharedTokenAcrossTwoRecipientsIsSentOnceAndCountedDeduped() {
        when(users.findById(1L)).thenReturn(Optional.of(user(1L)));
        when(users.findById(2L)).thenReturn(Optional.of(user(2L)));
        // Both users resolve the SAME handed-down device token "shared", plus each their own.
        stubTokens(1L, "shared", "own-1");
        stubTokens(2L, "shared", "own-2");
        // First recipient sends both of its tokens; the second only its own (shared already sent).
        when(push.sendToTokens(eq(List.of("shared", "own-1")), any())).thenReturn(new PushFanout(2, 2, 0, 0));
        when(push.sendToTokens(eq(List.of("own-2")), any())).thenReturn(new PushFanout(1, 1, 0, 0));
        stubHeaderSaveReturningId(9L);

        BroadcastResult result = service().broadcast(ACTOR, List.of(1L, 2L), "T", "B", null);

        // "shared" was handed to the sender exactly once (with recipient 1), never again.
        verify(push).sendToTokens(eq(List.of("shared", "own-1")), any());
        verify(push).sendToTokens(eq(List.of("own-2")), any());
        assertThat(result.dedupedTokens()).isEqualTo(1);
        assertThat(result.targeted()).isEqualTo(3); // shared + own-1 + own-2 (not 4)
        assertThat(result.delivered()).isEqualTo(3);
        assertThat(result.sent()).isEqualTo(2);
        assertThat(result.recipients())
                .extracting(BroadcastResult.RecipientResult::outcome)
                .containsExactly(Outcome.SENT, Outcome.SENT);
    }

    @Test
    void secondBroadcastFromSameAdminInsideCooldownIsRejected() {
        when(users.findById(1L)).thenReturn(Optional.of(user(1L)));
        stubTokens(1L, "t1");
        when(push.sendToTokens(eq(List.of("t1")), any())).thenReturn(new PushFanout(1, 1, 0, 0));
        stubHeaderSaveReturningId(1L);
        BroadcastService service = service();

        service.broadcast(ACTOR, List.of(1L), "T", "B", null); // records the window
        clock.advance(Duration.ofSeconds(10)); // still inside the 30s cooldown

        assertThatThrownBy(() -> service.broadcast(ACTOR, List.of(1L), "T", "B", null))
                .isInstanceOf(BroadcastCooldownException.class);
    }

    @Test
    void broadcastIsAllowedAgainAfterCooldownElapsesAndCooldownIsPerAdmin() {
        when(users.findById(1L)).thenReturn(Optional.of(user(1L)));
        stubTokens(1L, "t1");
        when(push.sendToTokens(eq(List.of("t1")), any())).thenReturn(new PushFanout(1, 1, 0, 0));
        stubHeaderSaveReturningId(1L);
        BroadcastService service = service();

        service.broadcast(ACTOR, List.of(1L), "T", "B", null);
        // A different admin is not blocked by the first admin's window.
        service.broadcast("other-admin", List.of(1L), "T", "B", null);
        // And the first admin can send again once its window elapses.
        clock.advance(BroadcastService.COOLDOWN.plusSeconds(1));
        service.broadcast(ACTOR, List.of(1L), "T", "B", null);

        verify(push, org.mockito.Mockito.times(3)).sendToTokens(eq(List.of("t1")), any());
    }

    @Test
    void writesExactlyOneHeaderAndOneAuditRowWithTokenFreeSkipBrokenDownMetadata() {
        when(users.findById(1L)).thenReturn(Optional.of(user(1L)));
        when(users.findById(2L)).thenReturn(Optional.of(user(2L, NotificationPref.EMAIL))); // opted out
        stubTokens(1L, "t1");
        when(push.sendToTokens(eq(List.of("t1")), any())).thenReturn(new PushFanout(1, 1, 0, 0));
        stubHeaderSaveReturningId(99L);

        service().broadcast(ACTOR, List.of(1L, 2L), "Hello", "World", "#/profile");

        // One header row with the sent title/body/route + aggregate counters.
        ArgumentCaptor<NotificationBroadcast> header =
                ArgumentCaptor.forClass(NotificationBroadcast.class);
        verify(broadcasts).save(header.capture());
        NotificationBroadcast row = header.getValue();
        assertThat(row.getActorUid()).isEqualTo(ACTOR);
        assertThat(row.getTitle()).isEqualTo("Hello");
        assertThat(row.getBody()).isEqualTo("World");
        assertThat(row.getRoute()).isEqualTo("#/profile");
        assertThat(row.getRecipientCount()).isEqualTo(2);
        assertThat(row.getDelivered()).isEqualTo(1);
        assertThat(row.getSkipped()).isEqualTo(1); // the opted-out recipient

        // One audit summary keyed to the saved header id, carrying counts (incl. the skip breakdown +
        // deduped) / title / route — never tokens.
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> meta = ArgumentCaptor.forClass(Map.class);
        verify(audit).record(eq(ACTOR), eq(AuditAction.BROADCAST_SENT), eq("Broadcast"), eq("99"), meta.capture());
        assertThat(meta.getValue())
                .containsEntry("recipientCount", 2)
                .containsEntry("title", "Hello")
                .containsEntry("route", "#/profile")
                .containsEntry("delivered", 1)
                .containsEntry("skippedOptedOut", 1)
                .containsEntry("skippedDisabled", 0)
                .containsEntry("skippedNotFound", 0)
                .containsEntry("dedupedTokens", 0);
        assertThat(meta.getValue().values())
                .noneSatisfy(v -> assertThat(String.valueOf(v)).contains("token"));
    }

    @Test
    void nullRouteWritesEmptyRouteInAuditAndNoRouteOnHeader() {
        when(users.findById(1L)).thenReturn(Optional.of(user(1L)));
        stubTokens(1L, "t1");
        when(push.sendToTokens(eq(List.of("t1")), any())).thenReturn(new PushFanout(1, 1, 0, 0));
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

    /** A test {@link Clock} whose instant can be advanced to drive the cooldown deterministically. */
    private static final class MutableClock extends Clock {
        private Instant now;

        MutableClock(Instant start) {
            this.now = start;
        }

        void advance(Duration by) {
            now = now.plus(by);
        }

        @Override
        public Instant instant() {
            return now;
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }
    }
}
