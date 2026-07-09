package com.teammarhaba.backend.notify;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * {@link NotificationWriter}'s write rules (TM-453) against mocked collaborators — the real
 * persistence + retention round-trip is covered by {@link NotificationWriterIntegrationTest}. Here we
 * pin what this class owns: one row per <em>active</em> recipient with the right typed fields, the
 * account rails (tombstoned/suspended dropped) applied <em>without</em> a push-pref filter, the
 * per-(user, type, sourceRef) idempotency guard, input de-duplication, the retention purge after each
 * insert, and the sticky-capable admin path.
 */
@ExtendWith(MockitoExtension.class)
class NotificationWriterTest {

    private static final PushMessage MESSAGE =
            new PushMessage("Event updated: Iftar Meetup", "The start time changed — tap for details.", "#/events/42");
    private static final String SOURCE_REF = "event:42:updated:v3";

    @Mock private NotificationRepository notifications;
    @Mock private UserRepository users;

    private NotificationWriter writer() {
        return new NotificationWriter(notifications, users);
    }

    /** A real {@link User} with its id + enabled flag set via reflection (getId/isEnabled are final). */
    private static User user(long id, boolean enabled) {
        User u = new User("uid-" + id, "u" + id + "@example.com", null);
        setField(u, "id", id);
        setField(u, "enabled", enabled);
        return u;
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

    // ------------------------------------------------------------------ system writes

    @Test
    void writeSystemPersistsOneTypedRowPerActiveUserAndPurgesEach() {
        when(users.findAllById(any())).thenReturn(List.of(user(1L, true), user(2L, true)));

        int written = writer().writeSystem(NotificationType.EVENT_UPDATED, List.of(1L, 2L), MESSAGE, SOURCE_REF);

        assertThat(written).isEqualTo(2);
        ArgumentCaptor<Notification> saved = ArgumentCaptor.forClass(Notification.class);
        verify(notifications, org.mockito.Mockito.times(2)).save(saved.capture());
        assertThat(saved.getAllValues())
                .allSatisfy(n -> {
                    assertThat(n.getType()).isEqualTo(NotificationType.EVENT_UPDATED);
                    assertThat(n.getTitle()).isEqualTo(MESSAGE.title());
                    assertThat(n.getBody()).isEqualTo(MESSAGE.body());
                    assertThat(n.getDeepLink()).isEqualTo("#/events/42"); // the push route becomes the deep-link
                    assertThat(n.getSourceRef()).isEqualTo(SOURCE_REF);
                    assertThat(n.isSticky()).isFalse(); // only the admin path may pin
                })
                .extracting(Notification::getUserId)
                .containsExactly(1L, 2L); // caller order preserved
        // Continuous retention: the inbox is trimmed right after each insert.
        verify(notifications).purgeForUser(1L);
        verify(notifications).purgeForUser(2L);
    }

    @Test
    void writeSystemDropsTombstonedAndSuspendedAccountsWithoutAPrefFilter() {
        // id 3 is soft-deleted (UserRepository's @SQLRestriction never returns it); id 2 is suspended.
        // id 1 is active with the EMAIL pref — the writer must STILL write it (the in-app inbox is not a
        // push opt-out), proving no pref filtering happens here.
        when(users.findAllById(any())).thenReturn(List.of(user(1L, true), user(2L, false)));

        int written = writer().writeSystem(NotificationType.EVENT_REMINDER, List.of(1L, 2L, 3L), MESSAGE, "event:42:reminder:T_MINUS_1H");

        assertThat(written).isEqualTo(1); // only the active, enabled account
        ArgumentCaptor<Notification> saved = ArgumentCaptor.forClass(Notification.class);
        verify(notifications).save(saved.capture());
        assertThat(saved.getValue().getUserId()).isEqualTo(1L);
        verify(notifications).purgeForUser(1L);
        verify(notifications, never()).purgeForUser(2L);
        verify(notifications, never()).purgeForUser(3L);
    }

    @Test
    void writeSystemIsIdempotentPerSourceEvent() {
        // The row already exists for user 1 (a re-fired listener / redelivered source event); user 2 is new.
        when(users.findAllById(any())).thenReturn(List.of(user(1L, true), user(2L, true)));
        when(notifications.existsByUserIdAndTypeAndSourceRef(1L, NotificationType.EVENT_UPDATED, SOURCE_REF))
                .thenReturn(true);

        int written = writer().writeSystem(NotificationType.EVENT_UPDATED, List.of(1L, 2L), MESSAGE, SOURCE_REF);

        assertThat(written).isEqualTo(1); // user 1 skipped, user 2 written
        ArgumentCaptor<Notification> saved = ArgumentCaptor.forClass(Notification.class);
        verify(notifications).save(saved.capture());
        assertThat(saved.getValue().getUserId()).isEqualTo(2L);
        verify(notifications, never()).purgeForUser(1L);
        verify(notifications).purgeForUser(2L);
    }

    @Test
    void writeSystemDeduplicatesRepeatedRecipientIds() {
        when(users.findAllById(any())).thenReturn(List.of(user(1L, true)));

        int written = writer().writeSystem(NotificationType.EVENT_UPDATED, List.of(1L, 1L, 1L), MESSAGE, SOURCE_REF);

        assertThat(written).isEqualTo(1); // one row despite the id appearing three times
        verify(notifications, org.mockito.Mockito.times(1)).save(any(Notification.class));
    }

    @Test
    void writeSystemToUserWritesForTheSingleRecipient() {
        when(users.findAllById(any())).thenReturn(List.of(user(7L, true)));

        int written = writer()
                .writeSystemToUser(NotificationType.RSVP_CONFIRMED, 7L, MESSAGE, "event:42:rsvp");

        assertThat(written).isEqualTo(1);
        ArgumentCaptor<Notification> saved = ArgumentCaptor.forClass(Notification.class);
        verify(notifications).save(saved.capture());
        assertThat(saved.getValue().getUserId()).isEqualTo(7L);
        assertThat(saved.getValue().getType()).isEqualTo(NotificationType.RSVP_CONFIRMED);
        assertThat(saved.getValue().getSourceRef()).isEqualTo("event:42:rsvp");
    }

    @Test
    void emptyRecipientsWriteNothingAndTouchNoRepository() {
        assertThat(writer().writeSystem(NotificationType.EVENT_UPDATED, List.of(), MESSAGE, SOURCE_REF)).isZero();
        verifyNoInteractions(notifications, users);
    }

    // ------------------------------------------------------------------ admin write (sticky-capable)

    @Test
    void writeAdminMessagePersistsAStickyAdminRow() {
        when(users.findAllById(any())).thenReturn(List.of(user(1L, true)));

        int written = writer()
                .writeAdminMessage(List.of(1L), "Welcome", "The app is live!", "#/home", "admin-msg:99", true);

        assertThat(written).isEqualTo(1);
        ArgumentCaptor<Notification> saved = ArgumentCaptor.forClass(Notification.class);
        verify(notifications).save(saved.capture());
        Notification n = saved.getValue();
        assertThat(n.getType()).isEqualTo(NotificationType.ADMIN_MESSAGE);
        assertThat(n.getTitle()).isEqualTo("Welcome");
        assertThat(n.getBody()).isEqualTo("The app is live!");
        assertThat(n.getDeepLink()).isEqualTo("#/home");
        assertThat(n.getSourceRef()).isEqualTo("admin-msg:99");
        assertThat(n.isSticky()).isTrue(); // the admin path is the only one allowed to pin
        verify(notifications).purgeForUser(1L);
    }

    @Test
    void nullSourceRefSkipsTheIdempotencyProbeAndAlwaysWrites() {
        when(users.findAllById(any())).thenReturn(List.of(user(1L, true)));

        int written = writer().writeAdminMessage(List.of(1L), "Hi", "Body", null, null, false);

        assertThat(written).isEqualTo(1);
        // A null sourceRef is un-dedupable, so we never even probe for an existing row.
        verify(notifications, never()).existsByUserIdAndTypeAndSourceRef(anyLong(), eq(NotificationType.ADMIN_MESSAGE), any());
        verify(notifications).save(any(Notification.class));
    }
}
