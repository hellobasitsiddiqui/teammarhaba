package com.teammarhaba.backend.user;

import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
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
}
