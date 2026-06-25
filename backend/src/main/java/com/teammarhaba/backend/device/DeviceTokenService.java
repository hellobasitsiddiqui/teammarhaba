package com.teammarhaba.backend.device;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import java.time.Instant;
import java.util.Map;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Registration and lifecycle of push device tokens (TM-283, epic TM-277). Each user may have many
 * device tokens; the backend stores them so the send-push service (TM-284) can target a push at the
 * right devices.
 *
 * <p><b>Register is an idempotent upsert keyed on the token value</b> ({@code device_tokens.token}
 * is globally unique): re-presenting the same token re-points it at the caller and refreshes its
 * platform + {@code updatedAt} rather than inserting a duplicate. This handles the common cases —
 * the same app re-registering on every launch, and a token migrating to a new account on a shared
 * device. The caller's account is provisioned just-in-time (as elsewhere) so registration works on a
 * brand-new account's first call.
 *
 * <p><b>Deregister</b> removes a token by value — used both by the client on sign-out / token
 * invalidation and by TM-284's prune path when FCM reports a token {@code unregistered}. Both routes
 * go through {@link #prune(String)}; the public {@link #deregister(VerifiedUser, String)} adds the
 * caller's identity to the audit trail.
 */
@Service
public class DeviceTokenService {

    /** Audit {@code target_type} for device-token events. */
    private static final String TARGET_DEVICE = "DeviceToken";

    private final DeviceTokenRepository tokens;
    private final UserService users;
    private final AuditService audit;

    public DeviceTokenService(DeviceTokenRepository tokens, UserService users, AuditService audit) {
        this.tokens = tokens;
        this.users = users;
        this.audit = audit;
    }

    /**
     * Upsert the caller's device token (TM-283). Provision-then-upsert, so a registration before any
     * {@code GET /me} still works. Idempotent on the token value: an existing row is re-pointed at the
     * caller and its platform/timestamp refreshed; otherwise a new row is inserted. The rare insert
     * race (two concurrent first-registrations of the same token) collapses to a refresh.
     */
    @Transactional
    public DeviceToken register(VerifiedUser caller, String token, DevicePlatform platform) {
        User user = users.provision(caller);
        Instant now = Instant.now();

        DeviceToken saved = tokens.findByToken(token)
                .map(existing -> {
                    existing.refresh(user.getId(), platform, now); // dirty-checking flushes on commit
                    return existing;
                })
                .orElseGet(() -> insertOrRefresh(user.getId(), token, platform, now));

        audit.record(
                caller.uid(),
                AuditAction.DEVICE_TOKEN_REGISTERED,
                TARGET_DEVICE,
                token,
                Map.of("platform", platform.name()));
        return saved;
    }

    /**
     * Deregister one of the caller's device tokens on sign-out / invalidation (TM-283). Prunes the
     * token by value; idempotent — deregistering an unknown/already-removed token is a no-op (and not
     * audited), so a client retrying sign-out never errors. Only an actual removal is audited.
     */
    @Transactional
    public void deregister(VerifiedUser caller, String token) {
        if (prune(token)) {
            audit.record(caller.uid(), AuditAction.DEVICE_TOKEN_DEREGISTERED, TARGET_DEVICE, token);
        }
    }

    /**
     * Prune a token by value, regardless of owner (TM-283). This is the seam the send-push service
     * (TM-284) calls when FCM reports a token {@code unregistered}, so a dead token is evicted on the
     * next send attempt. Returns {@code true} iff a row was actually removed, so callers can avoid
     * logging/auditing a no-op.
     */
    @Transactional
    public boolean prune(String token) {
        return tokens.deleteByToken(token) > 0;
    }

    /** Insert a fresh token; collapse the concurrent-insert race (unique token) into a refresh. */
    private DeviceToken insertOrRefresh(Long userId, String token, DevicePlatform platform, Instant when) {
        try {
            return tokens.saveAndFlush(new DeviceToken(userId, token, platform, when));
        } catch (DataIntegrityViolationException race) {
            // A concurrent first-registration won the insert (unique token) — treat as an upsert.
            DeviceToken existing = tokens.findByToken(token).orElseThrow(() -> race);
            existing.refresh(userId, platform, when);
            return existing;
        }
    }
}
