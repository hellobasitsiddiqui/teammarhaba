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
 */
public record UserResponse(
        Long id, String email, String displayName, String role, boolean enabled, String phoneNumber) {

    /** Projection without Firebase enrichment — the auth phone is unknown here, not known-absent. */
    public static UserResponse from(User user) {
        return from(user, null);
    }

    /** Projection plus the auth phone the caller read from Firebase (TM-372); may be {@code null}. */
    public static UserResponse from(User user, String authPhone) {
        return new UserResponse(
                user.getId(),
                user.getEmail(),
                user.getDisplayName(),
                user.getRole().name(),
                user.isEnabled(),
                authPhone);
    }
}
