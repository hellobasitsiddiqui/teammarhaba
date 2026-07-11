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
    EVENT_CANCELLED,

    /**
     * A member posted a message to an event group thread via {@code POST
     * /api/v1/conversations/{id}/messages} (TM-447, epic Event Chat). One row per post carrying the
     * conversation id as the target and the created message id in its metadata; the durable message
     * text lives in the {@code message} row, never in the audit log.
     */
    EVENT_CHAT_MESSAGE_POSTED,

    /**
     * An app admin removed (soft-deleted) a chat message via {@code POST
     * /api/v1/admin/conversations/{conversationId}/messages/{messageId}/remove} (TM-449, epic Event
     * Chat). One row per removal carrying the conversation id as the target and the removed message id
     * in its metadata. The message row is kept (soft-deleted, {@code deletedAt} stamped) so removal is
     * never a hard delete; it simply drops out of every timeline read. Idempotent — re-removing an
     * already-removed message still records the moderator's action (the audit log is append-only).
     */
    EVENT_CHAT_MESSAGE_REMOVED,

    /**
     * An author edited their OWN chat message via {@code PATCH
     * /api/v1/conversations/{conversationId}/messages/{messageId}} (TM-467, epic Event Chat). One row
     * per edit carrying the conversation id as the target and the edited message id in its metadata;
     * the durable (new) message text lives in the {@code message} row, never in the audit log. Distinct
     * from {@link #EVENT_CHAT_MESSAGE_REMOVED} (admin moderation) and {@link #EVENT_CHAT_MESSAGE_DELETED}
     * (author self-delete) so the log tells author self-service apart from moderation.
     */
    EVENT_CHAT_MESSAGE_EDITED,

    /**
     * An author deleted their OWN chat message via {@code DELETE
     * /api/v1/conversations/{conversationId}/messages/{messageId}} (TM-467, epic Event Chat) — a
     * soft-delete (the {@code message} row is kept, {@code deletedAt} stamped, so it drops out of every
     * timeline read). One row per delete carrying the conversation id as the target and the removed
     * message id in its metadata. Distinct from {@link #EVENT_CHAT_MESSAGE_REMOVED} (the SAME soft-delete
     * done by admin moderation, TM-449) so the log distinguishes an author taking their own message back
     * from a moderator removing someone else's.
     */
    EVENT_CHAT_MESSAGE_DELETED,

    /**
     * An app admin changed a thread member's mute / removal state via {@code POST
     * /api/v1/admin/conversations/{conversationId}/members/{userId}/mute} (TM-449, epic Event Chat).
     * One row per change carrying the conversation id as the target, and the affected {@code userId}
     * plus the new {@code mute} state ({@code READ_ONLY} = muted, {@code REMOVED} = kicked from the
     * thread, {@code NONE} = reinstated) in its metadata. Muting never touches the member's event RSVP —
     * a removed member is still "going" to the event, they just lose thread access.
     */
    EVENT_CHAT_MEMBER_MUTED,

    /**
     * A user self-switched their membership tier via {@code POST /api/v1/me/membership/tier} (TM-474 /
     * epic Membership). One row per <em>actual</em> change (switching to the tier already held is a
     * no-op and not recorded), carrying the account's {@code user_id} as the target and the
     * {@code from → to} tier transition in its metadata. Since TM-620 a change applied by the
     * subscription machinery (activation / downgrade) records the same action with a
     * {@code via=subscription} metadata marker; the self-switch endpoint itself is payment-gated.
     */
    MEMBERSHIP_TIER_CHANGED,

    /**
     * A recurring subscription was activated (TM-620 / epic Membership): the Subscribe checkout's first
     * charge settled (confirmed by the provider webhook), the card was saved for off-session renewals
     * and the paid tier was granted. One row per activation (including a re-subscribe after a cancel),
     * carrying the account's {@code user_id} as the target and the tier + period end in its metadata.
     */
    SUBSCRIPTION_STARTED,

    /**
     * A subscription renewal charge settled (TM-620): the scheduler charged the saved card off-session
     * and rolled the paid window forward one month. One row per successful renewal, carrying the
     * account's {@code user_id} as the target and the tier + new period end in its metadata.
     */
    SUBSCRIPTION_RENEWED,

    /**
     * A subscription renewal charge failed and the subscription entered (or continued) dunning
     * (TM-620): the row is PAST_DUE and a retry is scheduled. One row per failed attempt, carrying the
     * account's {@code user_id} as the target and the tier + retry count in its metadata.
     */
    SUBSCRIPTION_RENEWAL_FAILED,

    /**
     * The user cancelled their subscription via {@code POST /api/v1/me/subscription/cancel} (TM-620):
     * renewals stop, the paid tier survives to the period end, then the scheduler downgrades. One row
     * per cancel, carrying the account's {@code user_id} as the target and the tier + period end (when
     * the tier will lapse) in its metadata.
     */
    SUBSCRIPTION_CANCELED,

    /**
     * A subscription reached its terminal end and the membership was downgraded to pay-per-event
     * (TM-620): either dunning exhausted its retries, or a user-cancelled subscription's paid period ran
     * out. One row per lapse, carrying the account's {@code user_id} as the target and the tier + reason
     * ({@code dunning_exhausted} / {@code period_ended}) in its metadata.
     */
    SUBSCRIPTION_LAPSED,

    /**
     * A reliability penalty was applied to an account (TM-409): a late event cancellation debited the
     * account's reliability points and bumped its strike counter ({@code users.late_cancel_count}). This
     * is the reliability <em>ledger</em> — one immutable, append-only row per penalty, targeting the
     * account (target {@code User} / the Firebase UID). Its metadata carries the signed points
     * {@code delta}, the {@code reason} ({@code LATE_CANCEL}), the {@code eventId} the strike came from,
     * and the resulting running {@code strikeCount} + {@code status}. Recorded by
     * {@code ReliabilityService} inside the un-RSVP transaction, so the penalty and its ledger row commit
     * together. The admin console reads a user's ledger by filtering the audit search on this target.
     */
    RELIABILITY_PENALTY
}
