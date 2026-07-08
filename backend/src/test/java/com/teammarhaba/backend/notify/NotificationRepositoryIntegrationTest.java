package com.teammarhaba.backend.notify;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;

/**
 * Verifies the {@code notification} store against a real Postgres (Testcontainers): the {@code
 * V21__create_notifications} migration applies and Hibernate's validate-only mapping matches the DDL
 * (the context would fail to start otherwise), a saved notification round-trips every field (nullable
 * {@code deep_link}/{@code source_ref} included) with a DB-generated {@code created_at}, the feed
 * finder is newest-first and user-scoped, the unseen/unread counts track the two timestamps, the
 * mark-seen/read transitions are one-way, and the retention purge keeps the last-N non-sticky per
 * user while exempting sticky ones. Every query is scoped to a freshly-created user so the shared
 * integration context's accumulated rows don't interfere.
 */
class NotificationRepositoryIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private NotificationRepository notifications;

    @Autowired
    private UserRepository users;

    @Autowired
    private JdbcTemplate jdbc;

    private Long newUser(String uid) {
        return users.save(new User(uid, uid + "@example.com", uid)).getId();
    }

    @Test
    void savePersistsAllFieldsWithDbTimestampAndNullableRefsRoundTrip() {
        Long userId = newUser("notif-save-1");

        Notification saved =
                notifications.save(
                        new Notification(
                                userId,
                                NotificationType.ADMIN_MESSAGE,
                                "Welcome",
                                "The app is live!",
                                "/home",
                                "msg-42"));

        assertThat(saved.getId()).isNotNull();
        assertThat(saved.getCreatedAt()).isNotNull(); // DB-generated default now()

        Notification reloaded = notifications.findById(saved.getId()).orElseThrow();
        assertThat(reloaded.getUserId()).isEqualTo(userId);
        assertThat(reloaded.getType()).isEqualTo(NotificationType.ADMIN_MESSAGE);
        assertThat(reloaded.getTitle()).isEqualTo("Welcome");
        assertThat(reloaded.getBody()).isEqualTo("The app is live!");
        assertThat(reloaded.getDeepLink()).isEqualTo("/home");
        assertThat(reloaded.getSourceRef()).isEqualTo("msg-42");
        assertThat(reloaded.isSticky()).isFalse(); // default
        assertThat(reloaded.getSeenAt()).isNull(); // unseen
        assertThat(reloaded.getReadAt()).isNull(); // unread

        // The two optional refs round-trip as NULL when omitted.
        Notification noRefs =
                notifications.save(
                        new Notification(
                                userId, NotificationType.EVENT_REMINDER, "Soon", "Your event starts soon", null, null));
        Notification noRefsReloaded = notifications.findById(noRefs.getId()).orElseThrow();
        assertThat(noRefsReloaded.getDeepLink()).isNull();
        assertThat(noRefsReloaded.getSourceRef()).isNull();
    }

    @Test
    void feedIsNewestFirstAndScopedToUser() {
        Long userId = newUser("notif-feed-1");
        Long otherUserId = newUser("notif-feed-2");

        // Each save runs in its own transaction, so each row gets its own DB-side now() and a
        // monotonically increasing id — the finder orders by created_at DESC, id DESC.
        Long first = notifications.save(notif(userId, NotificationType.RSVP_CONFIRMED, "First")).getId();
        Long second = notifications.save(notif(userId, NotificationType.EVENT_UPDATED, "Second")).getId();
        Long third = notifications.save(notif(userId, NotificationType.EVENT_CANCELLED, "Third")).getId();
        // A different user's notification must never leak into this feed.
        notifications.save(notif(otherUserId, NotificationType.ADMIN_MESSAGE, "Other"));

        List<Notification> feed = notifications.findByUserIdOrderByCreatedAtDescIdDesc(userId);

        assertThat(feed).extracting(Notification::getId).containsExactly(third, second, first);
        assertThat(feed).extracting(Notification::getCreatedAt).isSortedAccordingTo((a, b) -> b.compareTo(a));
    }

    @Test
    void unseenAndUnreadCountsTrackTheTwoTimestamps() {
        Long userId = newUser("notif-count-1");
        Notification a = notifications.save(notif(userId, NotificationType.ADMIN_MESSAGE, "A"));
        Notification b = notifications.save(notif(userId, NotificationType.ADMIN_MESSAGE, "B"));
        notifications.save(notif(userId, NotificationType.ADMIN_MESSAGE, "C"));

        // All three start unseen and unread.
        assertThat(notifications.countByUserIdAndSeenAtIsNull(userId)).isEqualTo(3);
        assertThat(notifications.countByUserIdAndReadAtIsNull(userId)).isEqualTo(3);

        // Seeing one (not reading) drops the unseen count but not the unread count.
        a.markSeen(Instant.now());
        notifications.save(a);
        assertThat(notifications.countByUserIdAndSeenAtIsNull(userId)).isEqualTo(2);
        assertThat(notifications.countByUserIdAndReadAtIsNull(userId)).isEqualTo(3);

        // Reading another drops both (read implies seen).
        b.markRead(Instant.now());
        notifications.save(b);
        assertThat(notifications.countByUserIdAndSeenAtIsNull(userId)).isEqualTo(1);
        assertThat(notifications.countByUserIdAndReadAtIsNull(userId)).isEqualTo(2);
    }

    @Test
    void markSeenAndReadAreOneWayIdempotent() {
        Long userId = newUser("notif-mark-1");
        Notification n = notifications.save(notif(userId, NotificationType.ADMIN_MESSAGE, "Once"));

        Instant firstSeen = Instant.parse("2026-07-09T10:00:00Z");
        n.markSeen(firstSeen);
        n.markSeen(Instant.parse("2026-07-09T11:00:00Z")); // later call is a no-op
        assertThat(n.getSeenAt()).isEqualTo(firstSeen);

        // markRead back-fills seen when opened without a prior view, and is itself one-way.
        Long userId2 = newUser("notif-mark-2");
        Notification opened = notifications.save(notif(userId2, NotificationType.ADMIN_MESSAGE, "Opened"));
        Instant readAt = Instant.parse("2026-07-09T12:00:00Z");
        opened.markRead(readAt);
        assertThat(opened.getReadAt()).isEqualTo(readAt);
        assertThat(opened.getSeenAt()).isEqualTo(readAt); // seen back-filled
        opened.markRead(Instant.parse("2026-07-09T13:00:00Z"));
        assertThat(opened.getReadAt()).isEqualTo(readAt); // unchanged
    }

    @Test
    @Transactional // the @Modifying purge needs a transaction; the writer's service provides one.
    void purgeKeepsLastNNonStickyAndExemptsSticky() {
        Long userId = newUser("notif-purge-1");
        Long otherUserId = newUser("notif-purge-2");

        // Five non-sticky (ids increase with insert order) + two sticky, for the same user.
        Long n1 = notifications.save(notif(userId, NotificationType.EVENT_REMINDER, "n1")).getId();
        Long n2 = notifications.save(notif(userId, NotificationType.EVENT_REMINDER, "n2")).getId();
        Long n3 = notifications.save(notif(userId, NotificationType.EVENT_REMINDER, "n3")).getId();
        Long n4 = notifications.save(notif(userId, NotificationType.EVENT_REMINDER, "n4")).getId();
        Long n5 = notifications.save(notif(userId, NotificationType.EVENT_REMINDER, "n5")).getId();
        Long s1 = notifications.save(sticky(userId, "s1")).getId();
        Long s2 = notifications.save(sticky(userId, "s2")).getId();
        // Another user's rows must be untouched by a purge scoped to userId.
        Long otherId = notifications.save(notif(otherUserId, NotificationType.ADMIN_MESSAGE, "other")).getId();

        // Keep the last 3 non-sticky: n1 and n2 (oldest/lowest ids) are purged; n3..n5 + both sticky stay.
        int removed = notifications.purgeNonStickyBeyondCapForUser(userId, 3);
        assertThat(removed).isEqualTo(2);

        assertThat(notifications.findByUserIdOrderByCreatedAtDescIdDesc(userId))
                .extracting(Notification::getId)
                .containsExactlyInAnyOrder(n3, n4, n5, s1, s2)
                .doesNotContain(n1, n2);
        // The other user's inbox is untouched.
        assertThat(notifications.findById(otherId)).isPresent();
    }

    @Test
    void notificationsSurviveAttendeeSoftDeleteAndPeopleResolveThroughUser() {
        Long userId = newUser("notif-tombstone");
        notifications.save(notif(userId, NotificationType.ADMIN_MESSAGE, "kept"));

        // Account soft-delete is a tombstone, not a hard DELETE — the FK's CASCADE never fires.
        jdbc.update("update users set deleted_at = now() where id = ?", userId);

        // The notification row survives (history stays), but the person no longer resolves through the
        // User aggregate — which is why callers resolve people through UserRepository, never this table.
        assertThat(notifications.findByUserIdOrderByCreatedAtDescIdDesc(userId)).hasSize(1);
        assertThat(users.findById(userId)).isEmpty();
    }

    private static Notification notif(Long userId, NotificationType type, String title) {
        return new Notification(userId, type, title, title + " body", null, null);
    }

    private static Notification sticky(Long userId, String title) {
        return new Notification(userId, NotificationType.ADMIN_MESSAGE, title, title + " body", null, null, true);
    }
}
