package com.teammarhaba.backend.device;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Data access for {@link DeviceToken} (TM-283). The token value is the natural key:
 * {@link #findByToken(String)} backs the idempotent upsert on register.
 * {@link #deleteByTokenAndUserId(String, Long)} backs the caller's owner-scoped
 * deregister-on-sign-out (TM-291), so a user can only remove their own token, while the unscoped
 * {@link #deleteByToken(String)} is reserved for the TM-284 prune-on-{@code unregistered} path (a
 * dead token is evicted regardless of owner). {@link #findByUserId(Long)} is what the send-push
 * service (TM-284) uses to fan a push out to all of a user's devices.
 */
public interface DeviceTokenRepository extends JpaRepository<DeviceToken, Long> {

    Optional<DeviceToken> findByToken(String token);

    List<DeviceToken> findByUserId(Long userId);

    /**
     * Whether {@code userId} has at least one registered device token — the "has a device push could
     * reach" half of the admin push-eligibility signal (TM-427). Backs the single-account admin read
     * (GET/PATCH {@code /admin/users/{id}}); the list path uses the batched
     * {@link #findUserIdsWithTokens(Collection)} instead of one query per row.
     */
    boolean existsByUserId(Long userId);

    /**
     * Of the given {@code userIds}, those that own at least one device token (TM-427) — a single batched
     * query so the admin users list can compute per-row push-eligibility without an N+1 fan-out. Returns
     * the distinct owning user ids; ids with no token are simply absent from the result.
     */
    @Query("select distinct d.userId from DeviceToken d where d.userId in :userIds")
    List<Long> findUserIdsWithTokens(@Param("userIds") Collection<Long> userIds);

    /**
     * Delete a token by its value, regardless of owner. Returns the number of rows removed (0 if the
     * token was unknown). Reserved for the TM-284 FCM-{@code unregistered} prune path, which must be
     * able to evict a dead token no matter who currently owns it. Do <b>not</b> use this for a
     * caller-driven deregister — use {@link #deleteByTokenAndUserId(String, Long)} so a user cannot
     * remove another account's token (TM-291).
     */
    @Modifying
    @Query("delete from DeviceToken d where d.token = :token")
    int deleteByToken(@Param("token") String token);

    /**
     * Delete a token only if it belongs to the given user (TM-291). Returns the number of rows
     * removed: 1 when the caller owned the token, 0 when the token is unknown <i>or</i> owned by a
     * different account — so a caller can never deregister someone else's token (cross-account push
     * silence). Backs {@link DeviceTokenService#deregister}.
     */
    @Modifying
    @Query("delete from DeviceToken d where d.token = :token and d.userId = :userId")
    int deleteByTokenAndUserId(@Param("token") String token, @Param("userId") Long userId);
}
