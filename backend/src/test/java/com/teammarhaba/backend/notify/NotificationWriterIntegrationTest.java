package com.teammarhaba.backend.notify;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * {@link NotificationWriter} end-to-end against a real Postgres (Testcontainers): the typed writers
 * commit durable {@code notification} rows that round-trip every field, the per-(user, type,
 * sourceRef) idempotency guard genuinely prevents a second row across two committed calls, distinct
 * source events each get their own row, and the retention purge the writer runs after each insert
 * trims non-sticky rows while exempting the admin path's sticky ones. Each test is scoped to a
 * freshly-created user so the shared context's accumulated rows never interfere.
 *
 * <p>Deliberately <em>not</em> {@code @Transactional}: the writer's own
 * {@code @Transactional(REQUIRES_NEW)} must commit each write like production (and the {@code @Modifying}
 * purge needs a live transaction), which only a Spring-proxied, non-test-transactional call exercises.
 */
class NotificationWriterIntegrationTest extends AbstractIntegrationTest {

    @Autowired private NotificationWriter writer;
    @Autowired private NotificationRepository notifications;
    @Autowired private UserRepository users;

    private Long newUser(String uid) {
        return users.save(new User(uid, uid + "@example.com", uid)).getId();
    }

    private static PushMessage message() {
        return new PushMessage("Event updated: Iftar", "The start time changed — tap for details.", "#/events/42");
    }

    @Test
    void writeSystemCommitsARowThatRoundTripsEveryField() {
        Long userId = newUser("nw-system-1");

        int written = writer.writeSystem(
                NotificationType.EVENT_UPDATED, List.of(userId), message(), "event:42:updated:v1");

        assertThat(written).isEqualTo(1);
        List<Notification> feed = notifications.findByUserIdOrderByCreatedAtDescIdDesc(userId);
        assertThat(feed).hasSize(1);
        Notification n = feed.get(0);
        assertThat(n.getType()).isEqualTo(NotificationType.EVENT_UPDATED);
        assertThat(n.getTitle()).isEqualTo("Event updated: Iftar");
        assertThat(n.getBody()).isEqualTo("The start time changed — tap for details.");
        assertThat(n.getDeepLink()).isEqualTo("#/events/42"); // the push route persisted as the deep-link
        assertThat(n.getSourceRef()).isEqualTo("event:42:updated:v1");
        assertThat(n.isSticky()).isFalse();
        assertThat(n.getCreatedAt()).isNotNull(); // DB-authoritative default now()
        assertThat(n.getSeenAt()).isNull(); // unseen
        assertThat(n.getReadAt()).isNull(); // unread
    }

    @Test
    void repeatedCallsWithTheSameSourceRefWriteExactlyOneRow() {
        Long userId = newUser("nw-idem-1");

        int first = writer.writeSystem(
                NotificationType.WAITLIST_OFFER, List.of(userId), message(), "event:42:offer:1720000000000");
        int second = writer.writeSystem(
                NotificationType.WAITLIST_OFFER, List.of(userId), message(), "event:42:offer:1720000000000");

        assertThat(first).isEqualTo(1);
        assertThat(second).isZero(); // idempotent: the redelivered source event writes nothing
        assertThat(notifications.findByUserIdOrderByCreatedAtDescIdDesc(userId)).hasSize(1);
    }

    @Test
    void distinctSourceEventsEachWriteTheirOwnRow() {
        Long userId = newUser("nw-distinct-1");

        // Two reminder milestones for the same event are distinct source events — two inbox rows.
        writer.writeSystem(NotificationType.EVENT_REMINDER, List.of(userId), message(), "event:42:reminder:T_MINUS_24H");
        writer.writeSystem(NotificationType.EVENT_REMINDER, List.of(userId), message(), "event:42:reminder:T_MINUS_1H");

        assertThat(notifications.findByUserIdOrderByCreatedAtDescIdDesc(userId))
                .extracting(Notification::getSourceRef)
                .containsExactlyInAnyOrder("event:42:reminder:T_MINUS_24H", "event:42:reminder:T_MINUS_1H");
    }

    @Test
    void adminStickyRowSurvivesTheRetentionPurgeThatTrimsNonSticky() {
        Long userId = newUser("nw-retain-1");

        // A pinned admin message first, then enough non-sticky system rows to cross the retention cap.
        writer.writeAdminMessage(List.of(userId), "Pinned", "Stays forever", "#/home", "admin-msg:1", true);
        for (int i = 0; i < NotificationRepository.RETAIN_PER_USER + 1; i++) {
            writer.writeSystem(
                    NotificationType.EVENT_REMINDER, List.of(userId), message(), "event:42:reminder:" + i);
        }

        List<Notification> feed = notifications.findByUserIdOrderByCreatedAtDescIdDesc(userId);
        // Kept: the last RETAIN_PER_USER non-sticky rows + the one exempt sticky row.
        assertThat(feed).hasSize(NotificationRepository.RETAIN_PER_USER + 1);
        assertThat(feed).filteredOn(Notification::isSticky).hasSize(1);
        assertThat(feed).filteredOn(n -> !n.isSticky()).hasSize(NotificationRepository.RETAIN_PER_USER);
        // The pinned admin row is still there; the very first non-sticky row was purged.
        assertThat(feed).anyMatch(n -> "admin-msg:1".equals(n.getSourceRef()));
        assertThat(feed).noneMatch(n -> "event:42:reminder:0".equals(n.getSourceRef()));
    }

    @Test
    void adminMessageWithNoDeepLinkRoundTripsAsNull() {
        Long userId = newUser("nw-nolink-1");

        writer.writeAdminMessage(List.of(userId), "No link", "Just text", null, "admin-msg:2", false);

        Notification n = notifications.findByUserIdOrderByCreatedAtDescIdDesc(userId).get(0);
        assertThat(n.getDeepLink()).isNull();
        assertThat(n.isSticky()).isFalse();
        assertThat(n.getType()).isEqualTo(NotificationType.ADMIN_MESSAGE);
    }
}
