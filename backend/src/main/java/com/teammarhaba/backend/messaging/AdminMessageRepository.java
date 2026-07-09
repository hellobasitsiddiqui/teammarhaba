package com.teammarhaba.backend.messaging;

import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.repository.Repository;

/**
 * Data access for the {@link AdminMessage append-only admin-message campaign log} (TM-441).
 *
 * <p>Deliberately extends the bare {@link Repository} marker rather than {@code JpaRepository}, so
 * <strong>no</strong> {@code delete*}/{@code save*}-all mutators are inherited — the only write is
 * {@link #save(AdminMessage)} (insert). The header's <em>definition</em> is immutable, so a save never
 * updates it; the single allowed update is the terminal <b>recall</b> marker (TM-473), applied by
 * mutating a managed entity loaded via {@link #findByIdAndActorUid} inside the recall transaction
 * (dirty-checking flush, no delete). That keeps "append-only definition, no delete" a compile-time
 * property of the data layer — the same enforcement as {@code NotificationBroadcastRepository} /
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

    /**
     * Load one campaign by id <em>scoped to its sender</em> — the recall path (TM-473). Scoping by
     * {@code actorUid} makes an unknown id AND another admin's message both resolve to
     * {@link Optional#empty()}, which the service turns into a uniform {@code 404} so recall never
     * leaks the existence of a campaign the caller didn't send (same 404-not-403 rule as the sent-
     * history read: an admin only ever acts on "messages <em>I</em> sent").
     */
    Optional<AdminMessage> findByIdAndActorUid(Long id, String actorUid);

    /** Total campaign count (used by tests / sanity checks). */
    long count();
}
