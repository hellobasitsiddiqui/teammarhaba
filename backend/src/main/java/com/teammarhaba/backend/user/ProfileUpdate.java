package com.teammarhaba.backend.user;

/**
 * A partial profile update for the verified caller (TM-162). Every field is optional: a
 * {@code null} leaves the corresponding column unchanged (PATCH semantics, as the existing
 * display-name update already behaved). Identity ({@code uid}/{@code email}) is never here — it
 * comes from the verified token, never the client.
 *
 * <p>This is the domain command the service applies. Transport-level validation (sizes, ranges,
 * enum/format) lives on the API DTO ({@code UpdateMeRequest}); this type stays free of web concerns
 * so the {@code user} package doesn't depend on {@code api}.
 */
public record ProfileUpdate(
        String displayName,
        String firstName,
        String lastName,
        String city,
        Integer age,
        String phone,
        NotificationPreference notificationPref,
        String timezone,
        String locale) {

    /** {@code true} if no field is set — applying it would change nothing. */
    public boolean isEmpty() {
        return displayName == null
                && firstName == null
                && lastName == null
                && city == null
                && age == null
                && phone == null
                && notificationPref == null
                && timezone == null
                && locale == null;
    }
}
