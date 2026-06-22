package com.teammarhaba.backend.audit;

/**
 * The kinds of action recorded in the {@link AuditEvent append-only audit log} (TM-113). Stored by
 * {@code name()}, so values may be added but existing names must not be renamed/removed (old rows
 * keep referencing them).
 *
 * <p>Account-lifecycle actions are wired in {@code UserService} now. The admin actions
 * ({@link #ROLE_CHANGED}, {@link #ACCOUNT_ENABLED_CHANGED}) are defined here for the admin
 * user-management endpoints (TM-111) to record against when they land.
 */
public enum AuditAction {

    /** A new account was provisioned just-in-time on first authenticated request (TM-112). */
    ACCOUNT_PROVISIONED,

    /** A returning user's soft-deleted account was reactivated on sign-in (TM-112/TM-114). */
    ACCOUNT_REACTIVATED,

    /** A user updated their own profile (e.g. display name) via {@code PATCH /api/v1/me}. */
    PROFILE_UPDATED,

    /** An account was soft-deleted (tombstoned). */
    ACCOUNT_SOFT_DELETED,

    /** A soft-deleted account was restored. */
    ACCOUNT_RESTORED,

    /** An admin changed an account's role (wired by the admin endpoints, TM-111). */
    ROLE_CHANGED,

    /** An admin enabled or disabled an account (wired by the admin endpoints, TM-111). */
    ACCOUNT_ENABLED_CHANGED
}
