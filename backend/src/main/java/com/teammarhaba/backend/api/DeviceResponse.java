package com.teammarhaba.backend.api;

import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import java.time.Instant;

/**
 * The registered device returned by {@code POST /api/v1/me/devices} (TM-283), so the client can
 * confirm what was stored. The {@code token} is echoed back (the client already holds it) alongside
 * the {@code platform} and the {@code updatedAt} stamp from the (idempotent) upsert.
 *
 * @param token     the registered push token
 * @param platform  the device platform it was registered for
 * @param updatedAt when the registration was last written (insert or refresh)
 */
public record DeviceResponse(String token, DevicePlatform platform, Instant updatedAt) {

    static DeviceResponse from(DeviceToken device) {
        return new DeviceResponse(device.getToken(), device.getPlatform(), device.getUpdatedAt());
    }
}
