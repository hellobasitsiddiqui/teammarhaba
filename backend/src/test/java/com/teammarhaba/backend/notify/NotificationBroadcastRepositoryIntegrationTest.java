package com.teammarhaba.backend.notify;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * Verifies the append-only broadcast log against a real Postgres (Testcontainers): the {@code
 * V10__create_notification_broadcasts} migration applies and Hibernate's validate-only mapping
 * matches the DDL (the context would fail to start otherwise), a saved broadcast persists with all
 * counters and the DB-generated timestamp, and the recent-by-actor finder returns it newest-first.
 * Queries are scoped by a unique actor id so the shared integration context's accumulated rows don't
 * interfere.
 */
class NotificationBroadcastRepositoryIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private NotificationBroadcastRepository broadcasts;

    @Test
    void savePersistsHeaderWithCountersAndDbTimestamp() {
        String actor = "broadcast-it-actor-1";

        NotificationBroadcast saved =
                broadcasts.save(
                        new NotificationBroadcast(
                                actor, "Welcome", "The app is live!", "/home", 10, 10, 8, 1, 1, 0));

        assertThat(saved.getId()).isNotNull();
        assertThat(saved.getCreatedAt()).isNotNull(); // DB-generated default now()

        List<NotificationBroadcast> byActor = broadcasts.findByActorUidOrderByCreatedAtDesc(actor);
        assertThat(byActor).hasSize(1);
        NotificationBroadcast b = byActor.get(0);
        assertThat(b.getActorUid()).isEqualTo(actor);
        assertThat(b.getTitle()).isEqualTo("Welcome");
        assertThat(b.getBody()).isEqualTo("The app is live!");
        assertThat(b.getRoute()).isEqualTo("/home");
        assertThat(b.getRecipientCount()).isEqualTo(10);
        assertThat(b.getTargeted()).isEqualTo(10);
        assertThat(b.getDelivered()).isEqualTo(8);
        assertThat(b.getPruned()).isEqualTo(1);
        assertThat(b.getFailed()).isEqualTo(1);
        assertThat(b.getSkipped()).isEqualTo(0);
        assertThat(b.getCreatedAt()).isNotNull();
    }

    @Test
    void nullRouteIsPersistedAndFinderIsMostRecentFirst() {
        String actor = "broadcast-it-actor-2";

        broadcasts.save(new NotificationBroadcast(actor, "First", "Older body", null, 3, 3, 3, 0, 0, 0));
        NotificationBroadcast second =
                broadcasts.save(
                        new NotificationBroadcast(actor, "Second", "Newer body", null, 5, 5, 5, 0, 0, 0));

        List<NotificationBroadcast> byActor = broadcasts.findByActorUidOrderByCreatedAtDesc(actor);
        assertThat(byActor).hasSize(2);
        assertThat(byActor.get(0).getId()).isEqualTo(second.getId()); // newest first
        assertThat(byActor.get(0).getRoute()).isNull(); // nullable route round-trips
    }
}
