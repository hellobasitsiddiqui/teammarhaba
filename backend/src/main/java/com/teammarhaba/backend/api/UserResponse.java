package com.teammarhaba.backend.api;

import com.teammarhaba.backend.user.User;

/**
 * An account as exposed by the admin user-management API (TM-111). Deliberately a <em>projection</em>
 * of {@link User} — it carries only what an admin console needs to list and manage accounts and
 * <strong>never leaks sensitive internals</strong> (no Firebase UID, no version/soft-delete columns).
 * The numeric {@code id} is the stable handle used by the management endpoints.
 *
 * @param id          database id — the handle for {@code PATCH /api/v1/admin/users/{id}}
 * @param email       the account email (may be {@code null})
 * @param displayName the profile name (may be {@code null})
 * @param role        {@code USER} or {@code ADMIN}
 * @param enabled     whether the account is active or suspended
 * @param phoneNumber the verified auth phone number, read live from Firebase (TM-372) — the
 *                    identifier for phone-auth accounts that have no email/display name, so the
 *                    admin console never renders a blank row. Distinct from the user-editable
 *                    profile {@code phone} field, which is not exposed here. {@code null} whenever
 *                    the account has no phone identity or Firebase couldn't be read (best-effort).
 * @param pushEligible whether a push notification could actually reach this account (TM-427): its
 *                    {@code notificationPref} permits push <strong>and</strong> it has at least one
 *                    registered device token. The admin send-notification page surfaces this and
 *                    blocks selecting/sending push to an ineligible account, so an admin can't fire a
 *                    push into the void. Mirrors the server-side broadcast opt-out/no-device skip
 *                    ({@code BroadcastService}) so the UI's "can receive push" and the send path agree.
 */
public record UserResponse(
        Long id,
        String email,
        String displayName,
        String role,
        boolean enabled,
        String phoneNumber,
        boolean pushEligible) {

    /** Projection without enrichment — no auth phone, and push-eligibility unknown (defaults false). */
    public static UserResponse from(User user) {
        return from(user, null, false);
    }

    /** Projection plus the auth phone (TM-372); push-eligibility not computed here (defaults false). */
    public static UserResponse from(User user, String authPhone) {
        return from(user, authPhone, false);
    }

    /**
     * Full admin projection (TM-372 auth phone + TM-427 push-eligibility). {@code pushEligible} is
     * computed by {@code UserAdminService} (pref permits push AND a device token exists), so the send
     * page can flag and exclude accounts a push can't reach.
     */
    public static UserResponse from(User user, String authPhone, boolean pushEligible) {
        return new UserResponse(
                user.getId(),
                user.getEmail(),
                user.getDisplayName(),
                user.getRole().name(),
                user.isEnabled(),
                authPhone,
                pushEligible);
    }
}
