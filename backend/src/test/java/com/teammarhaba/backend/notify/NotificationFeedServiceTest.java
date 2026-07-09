package com.teammarhaba.backend.notify;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.api.NotificationBadge;
import com.teammarhaba.backend.api.NotificationResponse;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;

/**
 * {@link NotificationFeedService} branching logic (TM-454), against mocked collaborators — no Spring,
 * no database (the round-trip is pinned by {@code NotificationFeedIntegrationTest}). Covers the parts
 * that are pure service behaviour: the caller is always resolved through {@link UserService#provision}
 * (never a client id); the badge is the two store counts; mark-seen delegates the bulk write and
 * returns the refreshed counts; and mark-read is owner-scoped — a foreign or unknown id is a
 * {@code 404} with no write.
 */
@ExtendWith(MockitoExtension.class)
class NotificationFeedServiceTest {

    private static final Long USER_ID = 42L;
    private static final VerifiedUser CALLER = new VerifiedUser("uid-42", "uid-42@example.com");

    @Mock private NotificationRepository notifications;
    @Mock private UserService users;
    @Mock private User user;

    private NotificationFeedService service;

    @BeforeEach
    void setUp() {
        service = new NotificationFeedService(notifications, users);
        // Every route resolves the owner from the verified caller via provision — stub it once.
        when(users.provision(CALLER)).thenReturn(user);
        when(user.getId()).thenReturn(USER_ID);
    }

    @Test
    void feedResolvesTheCallerAndMapsThePageToDtos() {
        Notification n = new Notification(USER_ID, NotificationType.ADMIN_MESSAGE, "Hi", "There", "/home", "ref-1");
        Pageable pageable = PageRequest.of(0, 20);
        when(notifications.findByUserId(USER_ID, pageable)).thenReturn(new PageImpl<>(List.of(n), pageable, 1));

        PageResponse<NotificationResponse> feed = service.feed(CALLER, pageable);

        assertThat(feed.totalElements()).isEqualTo(1);
        assertThat(feed.items()).singleElement().satisfies(dto -> {
            assertThat(dto.title()).isEqualTo("Hi");
            assertThat(dto.type()).isEqualTo(NotificationType.ADMIN_MESSAGE);
            assertThat(dto.seen()).isFalse();
            assertThat(dto.read()).isFalse();
        });
    }

    @Test
    void badgeReturnsTheUnseenAndUnreadCounts() {
        when(notifications.countByUserIdAndSeenAtIsNull(USER_ID)).thenReturn(3L);
        when(notifications.countByUserIdAndReadAtIsNull(USER_ID)).thenReturn(5L);

        NotificationBadge badge = service.badge(CALLER);

        assertThat(badge.unseen()).isEqualTo(3);
        assertThat(badge.unread()).isEqualTo(5);
    }

    @Test
    void markAllSeenDelegatesTheBulkWriteAndReturnsRefreshedCounts() {
        // After the bulk mark-seen the store reports zero unseen; unread is untouched.
        when(notifications.countByUserIdAndSeenAtIsNull(USER_ID)).thenReturn(0L);
        when(notifications.countByUserIdAndReadAtIsNull(USER_ID)).thenReturn(2L);

        NotificationBadge badge = service.markAllSeen(CALLER);

        verify(notifications).markAllSeenForUser(eq(USER_ID), any(Instant.class));
        assertThat(badge.unseen()).isZero();
        assertThat(badge.unread()).isEqualTo(2);
    }

    @Test
    void markReadMarksAnOwnedNotificationAndSavesIt() {
        Notification owned = new Notification(USER_ID, NotificationType.ADMIN_MESSAGE, "Tap", "me", null, null);
        when(notifications.findById(7L)).thenReturn(Optional.of(owned));
        when(notifications.save(owned)).thenReturn(owned);

        NotificationResponse response = service.markRead(CALLER, 7L);

        assertThat(owned.getReadAt()).isNotNull(); // one-way transition applied
        assertThat(owned.getSeenAt()).isNotNull(); // read back-fills seen
        assertThat(response.read()).isTrue();
        verify(notifications).save(owned);
    }

    @Test
    void markReadOfAForeignNotificationIsNotFoundAndWritesNothing() {
        // The row exists but belongs to someone else — indistinguishable from missing, and never saved.
        Notification foreign = new Notification(99L, NotificationType.ADMIN_MESSAGE, "Not", "yours", null, null);
        when(notifications.findById(7L)).thenReturn(Optional.of(foreign));

        assertThatThrownBy(() -> service.markRead(CALLER, 7L)).isInstanceOf(ResourceNotFoundException.class);
        assertThat(foreign.getReadAt()).isNull();
        verify(notifications, never()).save(any());
    }

    @Test
    void markReadOfAnUnknownIdIsNotFound() {
        when(notifications.findById(7L)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.markRead(CALLER, 7L)).isInstanceOf(ResourceNotFoundException.class);
        verify(notifications, never()).save(any());
    }
}
