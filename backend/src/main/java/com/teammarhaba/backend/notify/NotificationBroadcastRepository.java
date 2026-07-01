package com.teammarhaba.backend.notify;

import java.util.List;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.repository.Repository;

/**
 * Data access for the {@link NotificationBroadcast append-only admin-broadcast log} (TM-359).
 *
 * <p>Deliberately extends the bare {@link Repository} marker rather than {@code JpaRepository}, so
 * <strong>no</strong> {@code delete*}/{@code save*}-all mutators are inherited — the only write is
 * {@link #save(NotificationBroadcast)} (insert; the entity has no mutable state, so it never
 * updates). That makes "append-only — no update/delete" a compile-time property of the data layer,
 * not just a convention — exactly the same enforcement as {@code AuditRepository}. The finders
 * support reading a single admin's broadcast history, most-recent-first.
 */
public interface NotificationBroadcastRepository extends Repository<NotificationBroadcast, Long> {

    /** Append a new broadcast header. The entity is immutable, so this only ever inserts. */
    NotificationBroadcast save(NotificationBroadcast broadcast);

    /** This actor's broadcasts, most recent first. */
    List<NotificationBroadcast> findByActorUidOrderByCreatedAtDesc(String actorUid);

    /** This actor's broadcasts, most recent first, paged (ordering comes from the {@link Pageable}). */
    Page<NotificationBroadcast> findByActorUid(String actorUid, Pageable pageable);

    /** Total broadcast count (used by tests / sanity checks). */
    long count();
}
