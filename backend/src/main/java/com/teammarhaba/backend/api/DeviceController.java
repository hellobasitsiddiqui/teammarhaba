package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.SessionRevocationService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.device.DeviceTokenService;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * The caller's push devices under {@code /api/v1/me/devices} (the {@code /api/v1} prefix is applied
 * by {@link ApiV1Config}). Reaching it requires a valid Firebase {@code Bearer} token; an
 * anonymous/invalid token gets the uniform RFC 7807 {@code 401} from the security chain
 * (default-deny). Identity always comes from the verified {@link VerifiedUser} principal, never the
 * client, so a caller can only ever see/register/deregister against their own account.
 *
 * <ul>
 *   <li>{@code GET /me/devices} — list the caller's own push-registered devices (TM-924, the "Your
 *       devices" read): platform + last-seen ({@code updatedAt}) + first-seen ({@code createdAt}). An
 *       honest projection of {@code device_tokens}, NOT a session registry — a signed-in browser that
 *       never granted push has no row and won't appear; the UI says so.</li>
 *   <li>{@code POST /me/devices} — register (idempotent upsert) a device push token + platform for
 *       the caller (TM-283), so the send-push service (TM-284) can target it.</li>
 *   <li>{@code DELETE /me/devices/{token}} — deregister a token on sign-out / invalidation. Idempotent:
 *       removing an unknown token still returns {@code 204}.</li>
 *   <li>{@code POST /me/devices/sign-out-everywhere} — "sign out everywhere" (TM-924): revoke ALL of
 *       the caller's Firebase refresh tokens, so every session (including this one) is booted on its
 *       next request via the filter's {@code checkRevoked}. Per-device sign-out is deferred to
 *       TM-1077. Always {@code 204} — best-effort revoke, degrades quietly without an Admin SDK.</li>
 * </ul>
 */
@RestController
public class DeviceController {

    private final DeviceTokenService deviceTokens;
    private final SessionRevocationService sessionRevocation;

    DeviceController(DeviceTokenService deviceTokens, SessionRevocationService sessionRevocation) {
        this.deviceTokens = deviceTokens;
        this.sessionRevocation = sessionRevocation;
    }

    /**
     * List the caller's own push-registered devices (TM-924). Returns platform + last-seen + created
     * for each row the caller owns in {@code device_tokens}, newest re-registration first is <em>not</em>
     * guaranteed here (the client sorts) — the raw push token is never returned (it's a sender-usable
     * credential, and the list has no need for it). Empty list when the caller has registered no device
     * (e.g. a push-less browser) — a {@code 200}, never a {@code 404}.
     */
    @GetMapping("/me/devices")
    List<DeviceListResponse> list(@AuthenticationPrincipal VerifiedUser caller) {
        return deviceTokens.list(caller).stream().map(DeviceListResponse::from).toList();
    }

    /**
     * Register (or refresh) one of the caller's device push tokens (TM-283). Idempotent on the token
     * value: re-presenting the same token re-points it at the caller and refreshes its platform +
     * timestamp rather than creating a duplicate. Returns the stored registration so the client can
     * confirm what was persisted.
     */
    @PostMapping("/me/devices")
    DeviceResponse register(
            @AuthenticationPrincipal VerifiedUser caller, @RequestBody @Valid RegisterDeviceRequest request) {
        return DeviceResponse.from(deviceTokens.register(caller, request.token(), request.platform()));
    }

    /**
     * Deregister a device push token on sign-out / token invalidation (TM-283). Idempotent — removing
     * an unknown or already-removed token is still {@code 204 No Content}, so a retried sign-out never
     * errors. The token travels in the path; FCM registration tokens are URL-safe.
     */
    @DeleteMapping("/me/devices/{token}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void deregister(@AuthenticationPrincipal VerifiedUser caller, @PathVariable String token) {
        deviceTokens.deregister(caller, token);
    }

    /**
     * Sign the caller out of <em>every</em> session (TM-924): revoke all of their Firebase refresh
     * tokens so every already-issued ID token — including the one that made this call — stops verifying
     * on its next request (the {@code checkRevoked=true} filter enforces it). Reuses the same
     * {@code revokeRefreshTokens} primitive as the admin demotion path; there is no per-session
     * granularity in Firebase, so this is all-or-nothing by design (per-device sign-out is deferred to
     * TM-1077). Best-effort and idempotent — always {@code 204}: with no Admin SDK (dev/test/CI) the
     * revoke degrades to a logged no-op rather than a 500, since a caller asking to sign out is left no
     * worse off if the revoke can't be delivered.
     */
    @PostMapping("/me/devices/sign-out-everywhere")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void signOutEverywhere(@AuthenticationPrincipal VerifiedUser caller) {
        sessionRevocation.signOutEverywhere(caller.uid());
    }
}
