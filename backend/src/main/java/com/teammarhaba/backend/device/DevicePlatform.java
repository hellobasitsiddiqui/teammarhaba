package com.teammarhaba.backend.device;

/**
 * The platform a registered push device runs on (TM-283). Stored on the {@code device_tokens} row by
 * {@code name()} via {@code EnumType.STRING} (same convention as {@code users.role} /
 * {@code users.notification_pref}), so values may be added but existing names must not be
 * renamed/removed (old rows keep referencing them).
 *
 * <p>{@code WEB} covers the browser/PWA build that shares the same codebase as the Capacitor native
 * shells (epic TM-277); {@code ANDROID}/{@code IOS} are the native FCM/APNs targets.
 */
public enum DevicePlatform {
    ANDROID,
    IOS,
    WEB
}
