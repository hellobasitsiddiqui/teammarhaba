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
    ACCOUNT_ENABLED_CHANGED,

    /** A user finished first-run onboarding via {@code POST /api/v1/me/onboarding-complete} (TM-163). */
    ONBOARDING_COMPLETED,

    /** A user accepted a terms version via {@code POST /api/v1/me/accept-terms} (TM-163). */
    TERMS_ACCEPTED,

    /** A user registered (or refreshed) a push device token via {@code POST /api/v1/me/devices} (TM-283). */
    DEVICE_TOKEN_REGISTERED,

    /** A device token was deregistered — sign-out or FCM-reported invalidation (TM-283/TM-284). */
    DEVICE_TOKEN_DEREGISTERED,

    /**
     * An admin sent a broadcast notification to real users (TM-359 / epic TM-358). One summary row
     * per send; the full header (title/body/recipient-count/outcome) lives in {@code
     * notification_broadcasts}.
     */
    BROADCAST_SENT,

    /**
     * An admin sent an audience-resolved message via {@code POST /api/v1/admin/messages} (TM-441 /
     * epic TM-432). One summary row per send carrying the target type, recipient count and delivery
     * counts; the full campaign header (title/body/target/recipient-count) lives in {@code
     * admin_message}, and the per-recipient inbox rows in {@code notification}.
     */
    ADMIN_MESSAGE_SENT,

    /**
     * An admin recalled (unsent) a message they had sent via {@code POST
     * /api/v1/admin/messages/{id}/recall} (TM-473 / epic TM-432). One row per recall carrying the
     * campaign id and how many in-app copies were removed; the header row is stamped recalled
     * ({@code recalled_at}/{@code recalled_by}). Best-effort on push — an already-delivered OS-tray
     * push can't be un-sent, so only the in-app inbox + bell copies are removed.
     */
    ADMIN_MESSAGE_RECALLED,

    /** An admin created a meetup event via {@code POST /api/v1/admin/events} (TM-392). */
    EVENT_CREATED,

    /** An admin edited an event via {@code PATCH /api/v1/admin/events/{id}} (TM-392). */
    EVENT_UPDATED,

    /**
     * An admin cancelled an event via {@code POST /api/v1/admin/events/{id}/cancel} (TM-392). The
     * row is kept (status {@code CANCELLED}) — cancel is not delete.
     */
    EVENT_CANCELLED
}
