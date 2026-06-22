package com.teammarhaba.backend.api;

import com.teammarhaba.backend.user.Role;

/**
 * Body for {@code PATCH /api/v1/admin/users/{id}} (TM-111). Partial update: a {@code null} field is
 * left unchanged, so an admin can toggle {@code enabled}, change {@code role}, or both in one call.
 *
 * @param enabled suspend ({@code false}) / reinstate ({@code true}) the account; {@code null} = leave as-is
 * @param role    the new role ({@code USER}/{@code ADMIN}); {@code null} = leave as-is
 */
public record UpdateUserRequest(Boolean enabled, Role role) {

    /** {@code true} if the request would change nothing (both fields omitted). */
    public boolean isEmpty() {
        return enabled == null && role == null;
    }
}
