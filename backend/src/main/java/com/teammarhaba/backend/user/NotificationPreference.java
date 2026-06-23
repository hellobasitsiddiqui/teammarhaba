package com.teammarhaba.backend.user;

/**
 * How a user prefers to be notified (TM-162). Stored by {@code name()} on
 * {@code users.notification_pref} (default {@link #EMAIL}). Like {@link Role}, values may be added
 * but existing names must not be renamed/removed — old rows keep referencing them.
 */
public enum NotificationPreference {

    /** Email only (the default for every new account). */
    EMAIL,

    /** Push notifications only. */
    PUSH,

    /** Both email and push. */
    BOTH
}
