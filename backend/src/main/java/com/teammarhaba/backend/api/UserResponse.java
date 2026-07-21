package com.teammarhaba.backend.api;

import com.teammarhaba.backend.event.ReliabilityStatus;
import com.teammarhaba.backend.user.NotificationPref;
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
 * @param lateCancelCount the account's running late-cancellation strike count — its reliability
 *                    <em>score</em> (TM-409/TM-414). {@code 0} for an account that has never
 *                    late-cancelled. The per-strike reliability <em>ledger</em> is read separately via
 *                    the audit search ({@code GET /api/v1/admin/audit?targetType=User&targetId=<uid>}).
 * @param reliabilityStatus the account's derived reliability standing (TM-409): {@code OK},
 *                    {@code WARNED} or {@code DOWNGRADED}. Computed by the admin controller from the
 *                    strike count against the configured thresholds, so the console can flag limited
 *                    accounts; {@code OK} when the reliability feature is off.
 */
public record UserResponse(
        Long id,
        String email,
        String displayName,
        String role,
        boolean enabled,
        String phoneNumber,
        boolean pushEligible,
        int lateCancelCount,
        ReliabilityStatus reliabilityStatus,
        // The admin-editable profile fields (TM-162 set), surfaced so the admin console can DISPLAY
        // them and PREFILL the admin edit form (TM-172). Distinct from {@code phoneNumber} above, which
        // is the read-only verified AUTH phone from Firebase (TM-372); {@code phone} here is the
        // user-editable profile phone the admin edit writes via {@code PATCH .../{id}/profile}.
        String firstName,
        String lastName,
        String city,
        Integer age,
        String phone,
        NotificationPref notificationPref,
        String timezone,
        String locale) {

    /** Projection without enrichment — no auth phone, push-eligibility unknown, standing defaulted to OK. */
    public static UserResponse from(User user) {
        return from(user, null, false, ReliabilityStatus.OK);
    }

    /** Projection plus the auth phone (TM-372); push-eligibility/standing not computed here (default off/OK). */
    public static UserResponse from(User user, String authPhone) {
        return from(user, authPhone, false, ReliabilityStatus.OK);
    }

    /**
     * Full admin projection (TM-372 auth phone + TM-427 push-eligibility + TM-409 reliability).
     * {@code pushEligible} is computed by {@code UserAdminService} (pref permits push AND a device token
     * exists); {@code reliabilityStatus} is computed by the controller from the account's strike count
     * ({@code ReliabilityPolicy}) so the console can flag warned/downgraded accounts. The raw strike
     * count is carried straight from the entity as the reliability score.
     */
    public static UserResponse from(
            User user, String authPhone, boolean pushEligible, ReliabilityStatus reliabilityStatus) {
        return new UserResponse(
                user.getId(),
                user.getEmail(),
                user.getDisplayName(),
                user.getRole().name(),
                user.isEnabled(),
                authPhone,
                pushEligible,
                user.getLateCancelCount(),
                reliabilityStatus,
                user.getFirstName(),
                user.getLastName(),
                user.getCity(),
                user.getAge(),
                user.getPhone(),
                user.getNotificationPref(),
                user.getTimezone(),
                user.getLocale());
    }
}
