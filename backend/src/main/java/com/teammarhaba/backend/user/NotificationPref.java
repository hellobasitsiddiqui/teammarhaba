package com.teammarhaba.backend.user;

/**
 * How an account prefers to receive notifications (TM-162). Stored on the {@code users} row by
 * {@code name()} via {@code EnumType.STRING} (same convention as {@link Role}), so values may be
 * added but existing names must not be renamed/removed.
 *
 * <p>{@code BOTH} (email + push) is the default for every <em>new</em> account (TM-427): a fresh
 * account is set up to receive push the moment a device token registers, instead of silently missing
 * pushes because it defaulted to email-only. The Java default lives on {@link User}; the matching DB
 * column default is set by {@code V19__default_notification_pref_both} (it was {@code EMAIL} in
 * {@code V5__users_profile_fields}). Existing rows keep whatever value they already hold.
 */
public enum NotificationPref {
    EMAIL,
    PUSH,
    BOTH;

    /**
     * Whether this preference permits <strong>push</strong> delivery — the single source of truth for
     * "would a push reach this account's preference?" ({@code PUSH} or {@code BOTH}). Used both by the
     * admin broadcast opt-out rail (TM-364) and by the admin push-eligibility signal (TM-427), so the
     * UI's "can receive push" check and the server's skip logic can never drift apart. {@code EMAIL} is
     * the push opt-out.
     */
    public boolean permitsPush() {
        return this == PUSH || this == BOTH;
    }
}
