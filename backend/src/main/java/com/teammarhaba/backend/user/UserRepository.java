package com.teammarhaba.backend.user;

import jakarta.persistence.LockModeType;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Data access for {@link User}. {@link #findByFirebaseUid(String)} is the lookup used by
 * just-in-time provisioning (TM-112) — the Firebase UID is the account's natural key.
 *
 * <p>All derived/JPQL queries here (and the inherited {@code findAll}/{@code findById}) honour the
 * entity's {@code @SQLRestriction}, so they return <em>active</em> rows only — soft-deleted
 * accounts are invisible by default.
 */
public interface UserRepository extends JpaRepository<User, Long> {

    /** Active accounts only (soft-deleted rows are excluded by the entity's {@code @SQLRestriction}). */
    Optional<User> findByFirebaseUid(String firebaseUid);

    /**
     * True iff an <em>active</em> account exists for this uid <strong>and it is suspended</strong>
     * ({@code enabled = false}). The inbound authorization gate the auth filter consults per request
     * (TM-741/TM-742): an admin "disable/suspend" flips {@code users.enabled = false}, and this is what
     * turns that DB flag into an immediate access block — the filter refuses to authenticate a suspended
     * caller (→ uniform 401) rather than relying on a slow token-TTL expiry or Firebase revocation.
     *
     * <p>Deliberately a derived existence check, not a fetch: it must NOT break just-in-time provisioning
     * (TM-112). A brand-new caller has no row yet, so this returns {@code false} → the request authenticates
     * and the account is provisioned downstream (created {@code enabled}). Only a persisted, active,
     * suspended row returns {@code true}. Soft-deleted rows are excluded by the entity's
     * {@code @SQLRestriction}, so a tombstoned account is "no active row" here — its lifecycle is owned by
     * the soft-delete path, not this gate. Cheap: an indexed {@code firebase_uid} lookup, no entity load.
     */
    boolean existsByFirebaseUidAndEnabledFalse(String firebaseUid);

    /**
     * Lookup that <em>includes</em> soft-deleted rows — the restore/reactivation path. A native query
     * bypasses the {@code @SQLRestriction} (which only rewrites Hibernate-generated SQL). At most one
     * row exists per uid (firebase_uid is globally unique), so the result is unambiguous.
     */
    @Query(value = "SELECT * FROM users WHERE firebase_uid = :firebaseUid", nativeQuery = true)
    Optional<User> findAnyByFirebaseUid(@Param("firebaseUid") String firebaseUid);

    /**
     * Lookup by surrogate id that <em>includes</em> soft-deleted rows (TM-623) — for the scheduler /
     * webhook paths that must act on an account whatever its lifecycle state. The renewal engine uses
     * it to tell "account tombstoned → lapse the subscription, charge NOTHING" apart from "account
     * gone entirely" — the restricted {@code findById} conflates the two, and (before this) the engine
     * charged the card FIRST and only then blew up on the invisible account, retrying the charge every
     * tick. Native SQL bypasses the {@code @SQLRestriction} (which only rewrites Hibernate-generated
     * queries).
     */
    @Query(value = "SELECT * FROM users WHERE id = :id", nativeQuery = true)
    Optional<User> findAnyById(@Param("id") Long id);

    /**
     * Load the account holding a {@code SELECT ... FOR UPDATE} row lock — the per-user serialisation
     * point for the "one active event at a time" rule (TM-413/TM-423), mirroring
     * {@code EventRepository.findByIdForUpdate}. Taking this lock at the top of a GOING-landing command
     * (RSVP/claim) makes a single user's concurrent commands queue, so the non-locking active-event
     * guard can't be bypassed across two different events. The {@code @SQLRestriction} still applies
     * (soft-deleted rows don't load or lock); callers lock a just-provisioned, active row.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select u from User u where u.id = :id")
    Optional<User> findByIdForUpdate(@Param("id") Long id);

    /**
     * Paged, filtered listing for the admin users console (TM-115). Each filter is optional — a
     * {@code null} argument disables that clause. {@code q} matches email or display name
     * (case-insensitive substring). Active rows only (the entity's {@code @SQLRestriction} applies
     * to this JPQL query), so soft-deleted accounts never appear in the list.
     */
    @Query(
            """
            select u from User u
            where (:q is null
                   or lower(u.email) like lower(concat('%', cast(:q as string), '%'))
                   or lower(u.displayName) like lower(concat('%', cast(:q as string), '%')))
              and (:role is null or u.role = :role)
              and (:enabled is null or u.enabled = :enabled)
            """)
    Page<User> search(
            @Param("q") String q, @Param("role") Role role, @Param("enabled") Boolean enabled, Pageable pageable);

    /**
     * The active account ids whose profile city matches {@code city} — the city-wide audience for
     * admin messaging (TM-440). The match is case-insensitive and trims both sides, so stray casing
     * or whitespace ({@code "London"} vs {@code " london "}) selects the same people. Returns ids
     * only (not entities) — the resolver just needs the id set. Active rows only: the entity's
     * {@code @SQLRestriction} applies to this JPQL query, so soft-deleted accounts never appear, which
     * is exactly why a city audience can be taken straight from here without further validation.
     */
    @Query("select u.id from User u where lower(trim(u.city)) = lower(trim(:city))")
    List<Long> findActiveIdsByCity(@Param("city") String city);

    /**
     * The subset of {@code ids} that still map to an <em>active</em> account — the id-only projection
     * of {@code findAllById} used to validate audience candidates for admin messaging (TM-440). The
     * entity's {@code @SQLRestriction} filters the query, so a soft-deleted (or unknown) id simply
     * isn't returned. This is how explicit target user ids and GOING-attendee ids (whose attendance
     * rows outlive an account tombstone) are gated down to real recipients in one query. Pass a
     * non-empty collection.
     */
    @Query("select u.id from User u where u.id in :ids")
    List<Long> findActiveIdsByIdIn(@Param("ids") Collection<Long> ids);
}
