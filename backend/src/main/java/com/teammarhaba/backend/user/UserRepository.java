package com.teammarhaba.backend.user;

import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

/**
 * Data access for {@link User}. {@link #findByFirebaseUid(String)} is the lookup used by
 * just-in-time provisioning (TM-112) — the Firebase UID is the account's natural key.
 */
public interface UserRepository extends JpaRepository<User, Long> {

    Optional<User> findByFirebaseUid(String firebaseUid);
}
