package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.device.DeviceTokenService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
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
 * client, so a caller can only register/deregister against their own account.
 *
 * <ul>
 *   <li>{@code POST /me/devices} — register (idempotent upsert) a device push token + platform for
 *       the caller (TM-283), so the send-push service (TM-284) can target it.</li>
 *   <li>{@code DELETE /me/devices/{token}} — deregister a token on sign-out / invalidation. Idempotent:
 *       removing an unknown token still returns {@code 204}.</li>
 * </ul>
 */
@RestController
public class DeviceController {

    private final DeviceTokenService deviceTokens;

    DeviceController(DeviceTokenService deviceTokens) {
        this.deviceTokens = deviceTokens;
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
}
