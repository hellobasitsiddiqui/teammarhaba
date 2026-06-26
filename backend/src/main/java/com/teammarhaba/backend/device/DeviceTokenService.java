package com.teammarhaba.backend.device;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
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
 * <p><b>Re-pointing a token on register is deliberate and is <i>not</i> the cross-account hijack
 * surface (TM-291).</b> An FCM registration token is a per-app-install secret minted on the device
 * by Firebase; a caller can only ever present a token their own device currently holds. The
 * legitimate flow is a shared/handed-down device — user B signs out, user A signs in, the same
 * token re-registers and must migrate to A (otherwise pushes for A would land on B's now-stale
 * registration). Possession of the live token is therefore a sound proxy for device control, so we
 * keep the upsert re-point rather than rejecting a foreign-owned token. The actual hijack/silence
 * risk in this epic was the <em>deregister</em> path below, which is now owner-scoped.
 *
 * <p><b>Deregister is owner-scoped (TM-291).</b> {@link #deregister(VerifiedUser, String)} removes a
 * token only when it belongs to the caller, so user A can never deregister user B's token and
 * silence their pushes. The unscoped {@link #prune(String)} remains <em>solely</em> for TM-284's
 * FCM-{@code unregistered} cleanup, which must evict a dead token regardless of owner.
 */
@Service
public class DeviceTokenService {

    /** Audit {@code target_type} for device-token events. */
    private static final String TARGET_DEVICE = "DeviceToken";

    /**
     * Hex chars of the token's SHA-256 digest kept as the audit target id (TM-292). Enough to identify
     * a token across events (and tie a register to its later deregister) without ever recording the raw
     * FCM token — which is a sender-usable credential, so it must not land in the audit log.
     */
    private static final int TOKEN_FINGERPRINT_HEX_LEN = 16;

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
                fingerprint(token),
                Map.of("platform", platform.name()));
        return saved;
    }

    /**
     * Deregister one of the caller's <em>own</em> device tokens on sign-out / invalidation (TM-283,
     * owner-scoped per TM-291). Deletes the token only when it belongs to the caller, so a user can
     * never remove another account's token and silence their pushes. Idempotent — deregistering an
     * unknown, already-removed, or foreign-owned token is a no-op (and not audited), so a client
     * retrying sign-out never errors and a hijack attempt leaves no trace of success. Only an actual
     * removal of the caller's own token is audited.
     */
    @Transactional
    public void deregister(VerifiedUser caller, String token) {
        Long callerUserId = users.provision(caller).getId();
        if (tokens.deleteByTokenAndUserId(token, callerUserId) > 0) {
            audit.record(
                    caller.uid(), AuditAction.DEVICE_TOKEN_DEREGISTERED, TARGET_DEVICE, fingerprint(token));
        }
    }

    /**
     * Prune a token by value, regardless of owner (TM-283). This is the seam the send-push service
     * (TM-284) calls when FCM reports a token {@code unregistered}, so a dead token is evicted on the
     * next send attempt. It is intentionally <em>not</em> owner-scoped — a dead token must be removed
     * no matter who owns it — and for that reason must never back a caller-driven deregister (use the
     * owner-scoped {@link #deregister} for that, TM-291). Returns {@code true} iff a row was actually
     * removed, so callers can avoid logging/auditing a no-op.
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

    /**
     * A short, stable, non-reversible fingerprint of an FCM token for the audit trail (TM-292) — the
     * leading {@value #TOKEN_FINGERPRINT_HEX_LEN} hex chars of its SHA-256 digest. The raw token is a
     * sender-usable credential and must never be stored in audit logs; the digest still lets us
     * correlate a token's events (e.g. a register and its later deregister) without exposing it.
     */
    private static String fingerprint(String token) {
        try {
            byte[] out = MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(out.length * 2);
            for (byte b : out) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
            }
            return sb.substring(0, TOKEN_FINGERPRINT_HEX_LEN);
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is mandated by the JLS — unreachable on any conformant JVM.
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
