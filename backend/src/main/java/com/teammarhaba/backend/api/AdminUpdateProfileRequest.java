package com.teammarhaba.backend.api;

import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.ProfileUpdate;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code PATCH /api/v1/admin/users/{id}/profile} (TM-172) — an admin editing ANOTHER user's
 * admin-editable profile fields. This is the TM-162 profile set only: names, city, age, phone,
 * notification preference, timezone, locale. Identity ({@code uid}/{@code email}), role and
 * {@code enabled} are deliberately NOT here — those stay governed by the TM-111 admin endpoints
 * ({@code PATCH /api/v1/admin/users/{id}}); this adds profile fields only. Personalisation-only
 * fields ({@code themeAccent}/{@code themeSketchy}) and {@code interests} are also excluded — they're
 * the user's own choices, not something an admin edits on their behalf.
 *
 * <p>Every field is optional; a {@code null} leaves that field unchanged (partial PATCH), so an admin
 * can fix one field without resending the rest — the same partial semantics as {@link UpdateMeRequest}.
 *
 * <p><strong>Validation is deliberately IDENTICAL to the self-edit path</strong> (TM-172 requirement):
 * the boundary constraints below are the SAME as {@link UpdateMeRequest} — the shared name-like rule
 * ({@link UpdateMeRequest#NAME_LIKE}), the shared E.164 phone pattern, and the shared size caps — and
 * the deeper rules (the city allow-list TM-877, the 18–99 age band TM-884, and the timezone/locale
 * resolution) run in {@code UserService.applyProfileFields}, the SAME method the self-edit calls. So
 * an admin edit can never pass a value the user's own edit would reject, or vice versa.
 *
 * @param firstName        given name (name-like, TM-771)
 * @param lastName         family name (name-like, TM-771)
 * @param city             city name (name-like TM-771; allowed-list constrained TM-877 in the service)
 * @param age              age in years, 18–99 for new values (TM-884; band enforced in the service
 *                         behind the unchanged-guard, TM-900 — grandfathered values re-send fine)
 * @param phone            E.164-shaped phone: {@code +} then 7–15 digits, separators allowed between
 *                         digits (e.g. {@code +44 20 7946 0958}); {@code ""} clears
 * @param notificationPref delivery preference (EMAIL/PUSH/BOTH). <strong>View-only for admins</strong>
 *                         (TM-1109): an admin may SEE the current value but never CHANGE it — the
 *                         notification preference is the user's own personal delivery choice, edited
 *                         only via their own {@code PATCH /api/v1/me}. An unknown value is still a
 *                         uniform 400 at this boundary; a value that DIFFERS from the target's stored
 *                         preference is a {@code 422} in the service ({@code adminUpdateProfile}); a
 *                         re-sent no-op (same value) or an omitted field is accepted and never written.
 * @param timezone         IANA timezone id, e.g. {@code Europe/London} (resolved in the service)
 * @param locale           BCP-47 language tag, e.g. {@code en-GB} (resolved in the service)
 */
public record AdminUpdateProfileRequest(
        @Size(max = 255)
                @Pattern(regexp = UpdateMeRequest.NAME_LIKE, message = UpdateMeRequest.NAME_LIKE_MESSAGE)
                String firstName,
        @Size(max = 255)
                @Pattern(regexp = UpdateMeRequest.NAME_LIKE, message = UpdateMeRequest.NAME_LIKE_MESSAGE)
                String lastName,
        @Size(max = 255)
                @Pattern(regexp = UpdateMeRequest.NAME_LIKE, message = UpdateMeRequest.NAME_LIKE_MESSAGE)
                String city,
        // No @Min/@Max here — the 18–99 band (TM-884) is enforced in UserService behind the
        // unchanged-guard (TM-900), exactly as for the self-edit, so a grandfathered value re-sends fine.
        Integer age,
        // The SAME E.164 stored-shape pattern as UpdateMeRequest.phone (TM-781), referenced as a
        // SHARED constant (like NAME_LIKE) so the two paths can never drift: a future tweak to the
        // self-edit phone rule moves both. @Size(max = 32) bounds the separator-padded overall length.
        @Size(max = 32)
                @Pattern(regexp = UpdateMeRequest.PHONE_PATTERN, message = UpdateMeRequest.PHONE_MESSAGE)
                String phone,
        NotificationPref notificationPref,
        @Size(max = 64) String timezone,
        @Size(max = 35) String locale) {

    /**
     * Map onto the service-layer {@link ProfileUpdate} value object. The self-only fields
     * ({@code displayName}, {@code gender}, {@code nationality}, {@code bio}, {@code notificationPref},
     * {@code themeAccent}, {@code themeSketchy}, {@code interests}) are passed as {@code null} so the shared
     * {@code applyProfileFields} leaves them untouched — an admin edit only ever writes the profile
     * subset above.
     *
     * <p>{@code notificationPref} is deliberately passed as {@code null} (TM-1109): it is view-only for
     * admins, so the shared field-application path must never mutate it via the admin edit. The service
     * ({@code adminUpdateProfile}) still inspects the raw {@link #notificationPref()} to REJECT (422) an
     * attempted change before this mapping is applied — this {@code null} is the belt-and-braces second
     * guard so a change can never slip through even if that check were bypassed.
     */
    ProfileUpdate toProfileUpdate() {
        return new ProfileUpdate(
                null, // displayName — not admin-editable here (identity-adjacent; left unchanged)
                firstName,
                lastName,
                city,
                age,
                null, // gender (TM-955) — the user's own choice (like interests), not admin-editable
                null, // nationality (TM-1134) — the user's own choice, not admin-editable
                null, // bio (TM-1139) — the user's own intro, not admin-editable
                phone,
                null, // notificationPref (TM-1109) — VIEW-ONLY for admins; never written via this path
                timezone,
                locale,
                null, // themeAccent — user's own personalisation
                null, // themeSketchy — user's own personalisation
                null); // interests — user's own selection
    }
}
