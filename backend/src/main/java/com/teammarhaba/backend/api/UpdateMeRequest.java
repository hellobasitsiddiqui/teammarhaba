package com.teammarhaba.backend.api;

import com.teammarhaba.backend.user.NotificationPreference;
import com.teammarhaba.backend.user.ProfileUpdate;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code PATCH /api/v1/me} (TM-112 display name; TM-162 added the rest). Partial update:
 * a {@code null} field is left unchanged. Identity ({@code uid}/{@code email}) comes from the
 * verified token and can never be set here.
 *
 * <p>Transport validation only — sizes, the age range, a lenient phone shape, and a BCP-47-ish
 * locale tag. {@code notificationPref} is bound as the {@link NotificationPreference} enum, so an
 * unknown value is rejected as a malformed body (400) by the framework. The IANA {@code timezone}
 * is checked best-effort in the service (the authoritative zone set lives at runtime).
 *
 * @param displayName      profile name; {@code null} = unchanged
 * @param firstName        given name; {@code null} = unchanged
 * @param lastName         family name; {@code null} = unchanged
 * @param city             city; {@code null} = unchanged
 * @param age              age in years (13–120); {@code null} = unchanged
 * @param phone            free-form phone (digits and {@code + - ( ) space}); {@code null} = unchanged
 * @param notificationPref notification channel; {@code null} = unchanged
 * @param timezone         IANA timezone id (validated best-effort in the service); {@code null} = unchanged
 * @param locale           BCP-47 locale tag; {@code null} = unchanged
 */
public record UpdateMeRequest(
        @Size(max = 255) String displayName,
        @Size(max = 100) String firstName,
        @Size(max = 100) String lastName,
        @Size(max = 120) String city,
        @Min(13) @Max(120) Integer age,
        @Size(max = 32)
                @Pattern(
                        regexp = "^[+0-9 ()\\-]*$",
                        message = "must contain only digits and + - ( ) or spaces")
                String phone,
        NotificationPreference notificationPref,
        @Size(max = 64) String timezone,
        @Size(max = 35)
                @Pattern(
                        regexp = "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$",
                        message = "must be a BCP-47 language tag, e.g. en-GB")
                String locale) {

    /** Map to the domain command the service applies. */
    public ProfileUpdate toProfileUpdate() {
        return new ProfileUpdate(
                displayName, firstName, lastName, city, age, phone, notificationPref, timezone, locale);
    }
}
