package com.teammarhaba.backend.device;

import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Data access for {@link DeviceToken} (TM-283). The token value is the natural key:
 * {@link #findByToken(String)} backs the idempotent upsert on register, and
 * {@link #deleteByToken(String)} backs both the caller's deregister-on-sign-out and the TM-284
 * prune-on-{@code unregistered} path. {@link #findByUserId(Long)} is what the send-push service
 * (TM-284) uses to fan a push out to all of a user's devices.
 */
public interface DeviceTokenRepository extends JpaRepository<DeviceToken, Long> {

    Optional<DeviceToken> findByToken(String token);

    List<DeviceToken> findByUserId(Long userId);

    /**
     * Delete a token by its value. Returns the number of rows removed (0 if the token was unknown),
     * so callers can tell a real deregistration from a no-op without an extra read.
     */
    @Modifying
    @Query("delete from DeviceToken d where d.token = :token")
    int deleteByToken(@Param("token") String token);
}
