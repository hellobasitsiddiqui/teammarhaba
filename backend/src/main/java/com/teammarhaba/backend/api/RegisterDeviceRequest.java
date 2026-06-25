package com.teammarhaba.backend.api;

import com.teammarhaba.backend.device.DevicePlatform;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code POST /api/v1/me/devices} (TM-283). The caller registers one of their devices for
 * push by presenting its FCM/APNs registration {@code token} and the {@code platform} it runs on.
 * Identity comes from the verified token, never the client; the registration is upserted (idempotent
 * on the token value).
 *
 * @param token    the opaque push registration token; required, non-blank, max 512 chars (matches the
 *                 {@code device_tokens.token} column)
 * @param platform the device platform ({@code ANDROID} | {@code IOS} | {@code WEB}); required. An
 *                 unknown value is a uniform {@code 400} from the enum binding.
 */
public record RegisterDeviceRequest(
        @NotBlank @Size(max = 512) String token, @NotNull DevicePlatform platform) {}
