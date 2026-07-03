package com.teammarhaba.backend.user;

import jakarta.persistence.LockModeType;
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
     * Lookup that <em>includes</em> soft-deleted rows — the restore/reactivation path. A native query
     * bypasses the {@code @SQLRestriction} (which only rewrites Hibernate-generated SQL). At most one
     * row exists per uid (firebase_uid is globally unique), so the result is unambiguous.
     */
    @Query(value = "SELECT * FROM users WHERE firebase_uid = :firebaseUid", nativeQuery = true)
    Optional<User> findAnyByFirebaseUid(@Param("firebaseUid") String firebaseUid);

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
}
