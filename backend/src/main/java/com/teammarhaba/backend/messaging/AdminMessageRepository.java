package com.teammarhaba.backend.messaging;

import java.util.List;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.repository.Repository;

/**
 * Data access for the {@link AdminMessage append-only admin-message campaign log} (TM-441).
 *
 * <p>Deliberately extends the bare {@link Repository} marker rather than {@code JpaRepository}, so
 * <strong>no</strong> {@code delete*}/{@code save*}-all mutators are inherited — the only write is
 * {@link #save(AdminMessage)} (insert; the entity has no mutable state, so it never updates). That
 * makes "append-only — no update/delete" a compile-time property of the data layer, not just a
 * convention — exactly the same enforcement as {@code NotificationBroadcastRepository} /
 * {@code AuditRepository}. The finders support the sent-history read (TM-442): a single admin's
 * campaigns, most-recent-first.
 */
public interface AdminMessageRepository extends Repository<AdminMessage, Long> {

    /** Append a new campaign header. The entity is immutable, so this only ever inserts. */
    AdminMessage save(AdminMessage message);

    /** This actor's campaigns, most recent first (the sent-history read, TM-442). */
    List<AdminMessage> findByActorUidOrderByCreatedAtDesc(String actorUid);

    /** This actor's campaigns, most recent first, paged (ordering comes from the {@link Pageable}). */
    Page<AdminMessage> findByActorUid(String actorUid, Pageable pageable);

    /** Total campaign count (used by tests / sanity checks). */
    long count();
}
