package com.teammarhaba.backend.user;

/**
 * A row in the admin users list (TM-115) — the first adopter of the {@code PageResponse} convention.
 * Carries only non-sensitive, list-relevant fields. The admin endpoint (TM-111) serves pages of
 * these; it may extend the shape, but a list row never exposes the Firebase UID or lock version.
 *
 * @param id          the account's surrogate id
 * @param email       the account email (may be {@code null})
 * @param displayName the profile name (may be {@code null})
 * @param role        the role name ({@code USER} / {@code ADMIN})
 * @param enabled     whether the account is active (vs. suspended)
 */
public record UserSummary(Long id, String email, String displayName, String role, boolean enabled) {

    public static UserSummary from(User user) {
        return new UserSummary(
                user.getId(), user.getEmail(), user.getDisplayName(), user.getRole().name(), user.isEnabled());
    }
}
