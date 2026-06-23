package com.teammarhaba.backend.user;

/**
 * How an account prefers to receive notifications (TM-162). Stored on the {@code users} row by
 * {@code name()} via {@code EnumType.STRING} (same convention as {@link Role}), so values may be
 * added but existing names must not be renamed/removed. {@code EMAIL} is the default for every
 * account (DB default in {@code V5__users_profile_fields}).
 */
public enum NotificationPref {
    EMAIL,
    PUSH,
    BOTH
}
