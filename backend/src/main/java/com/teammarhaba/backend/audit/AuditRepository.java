package com.teammarhaba.backend.audit;

import java.util.List;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.Repository;
import org.springframework.data.repository.query.Param;

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

    /**
     * Paged search for the admin audit read endpoint (TM-137). Each filter is optional — a
     * {@code null} argument disables that clause. {@code targetType} matches case-insensitively (so
     * the UI's {@code user} matches the stored {@code User}). Ordering comes from the {@link Pageable}
     * (default: newest first). {@code cast(... as string)} keeps a null param from tripping Postgres'
     * untyped-parameter inference in {@code lower(...)}.
     */
    @Query(
            value =
                    """
                    select e from AuditEvent e
                    where (:actorUid is null or e.actorUid = :actorUid)
                      and (:targetType is null or lower(e.targetType) = lower(cast(:targetType as string)))
                      and (:targetId is null or e.targetId = :targetId)
                    """,
            countQuery =
                    """
                    select count(e) from AuditEvent e
                    where (:actorUid is null or e.actorUid = :actorUid)
                      and (:targetType is null or lower(e.targetType) = lower(cast(:targetType as string)))
                      and (:targetId is null or e.targetId = :targetId)
                    """)
    Page<AuditEvent> search(
            @Param("actorUid") String actorUid,
            @Param("targetType") String targetType,
            @Param("targetId") String targetId,
            Pageable pageable);
}
