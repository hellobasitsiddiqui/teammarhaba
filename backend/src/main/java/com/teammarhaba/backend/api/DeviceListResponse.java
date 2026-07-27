package com.teammarhaba.backend.api;

import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import java.time.Instant;

/**
 * One of the caller's push-registered devices, as returned by {@code GET /api/v1/me/devices}
 * (TM-924, the "Your devices" list). This is <strong>not</strong> a session registry — it lists the
 * rows in {@code device_tokens} owned by the caller, i.e. devices where the app registered a push
 * token. A signed-in browser that never granted notification permission has no row and so does not
 * appear here; the UI carries the honest copy that says so (see {@code biometric-settings.js}). A
 * real per-session view is deferred to TM-1077.
 *
 * <p>The raw FCM/APNs {@code token} is deliberately <em>not</em> exposed: it is a sender-usable
 * credential (its whole audit trail is fingerprinted rather than stored, see
 * {@code DeviceTokenService.fingerprint}) and the list has no need for it. We surface the stable row
 * {@code id} instead (usable as a React-style key / a future per-device deregister target under
 * TM-1077), the {@code platform}, and two timestamps: {@code lastSeen} (the {@code updatedAt} bumped
 * on every re-registration — the closest honest proxy for "last active on this device") and
 * {@code created} (first registration).
 *
 * @param id       the stable {@code device_tokens} row id (never the raw push token)
 * @param platform the device platform the token was registered for
 * @param lastSeen when the registration was last written (re-registration bumps this) — shown as
 *                 "last seen"
 * @param created  when the device first registered a push token
 */
public record DeviceListResponse(Long id, DevicePlatform platform, Instant lastSeen, Instant created) {

    static DeviceListResponse from(DeviceToken device) {
        return new DeviceListResponse(
                device.getId(), device.getPlatform(), device.getUpdatedAt(), device.getCreatedAt());
    }
}
