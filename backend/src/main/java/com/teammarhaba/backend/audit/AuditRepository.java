package com.teammarhaba.backend.audit;

import java.util.List;
import org.springframework.data.repository.Repository;

/**
 * Data access for the {@link AuditEvent append-only audit log} (TM-113).
 *
 * <p>Deliberately extends the bare {@link Repository} marker rather than {@code JpaRepository}, so
 * <strong>no</strong> {@code delete*}/{@code save*}-all mutators are inherited — the only write is
 * {@link #save(AuditEvent)} (insert; the entity has no mutable state, so it never updates). That
 * makes "append-only — no update/delete" a compile-time property of the data layer, not just a
 * convention. The finders support the natural read patterns (by actor, by target).
 */
public interface AuditRepository extends Repository<AuditEvent, Long> {

    /** Append a new event. The entity is immutable, so this only ever inserts. */
    AuditEvent save(AuditEvent event);

    /** This actor's events, most recent first. */
    List<AuditEvent> findByActorUidOrderByCreatedAtDesc(String actorUid);

    /** A target's history (e.g. one account's events), most recent first. */
    List<AuditEvent> findByTargetTypeAndTargetIdOrderByCreatedAtDesc(String targetType, String targetId);

    /** Total event count (used by tests / sanity checks). */
    long count();
}
