package com.teammarhaba.backend.api;

import com.teammarhaba.backend.user.NotificationPref;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code PATCH /api/v1/me} (TM-112, extended in TM-162). Only the user-editable profile
 * fields — identity ({@code uid}/{@code email}) comes from the verified token and can never be set
 * here. Every field is optional; a {@code null} leaves that field unchanged (partial PATCH
 * semantics), so a caller can update one field without resending the rest.
 *
 * <p>Validation is deliberately lenient at the edges (TM-162):
 *
 * <ul>
 *   <li>{@code age} — bounded to a sensible human range (13–120).
 *   <li>{@code phone} — lenient pattern: digits, spaces and common separators, optional leading
 *       {@code +}; we do not attempt to verify a real, dialable number. An empty string is also
 *       accepted (clear/leave blank), consistent with the optional {@code @Size} text fields.
 *   <li>{@code notificationPref} — the {@link NotificationPref} enum; an unknown value is rejected
 *       by Jackson at deserialization time (uniform {@code 400}).
 *   <li>{@code timezone} (IANA id) and {@code locale} (BCP-47 tag) — best-effort validated in
 *       {@link com.teammarhaba.backend.user.UserService}, where {@link java.time.ZoneId}/
 *       {@link java.util.Locale} resolution is available.
 * </ul>
 *
 * @param displayName      the public display name
 * @param firstName        given name
 * @param lastName         family name
 * @param city             free-text city
 * @param age              age in years, 13–120
 * @param phone            lenient free-text phone number
 * @param notificationPref delivery preference (EMAIL/PUSH/BOTH)
 * @param timezone         IANA timezone id, e.g. {@code Europe/London}
 * @param locale           BCP-47 language tag, e.g. {@code en-GB}
 * @param themeAccent      the chosen Paper accent swatch id (TM-529). A fixed curated palette:
 *                         {@code teal|indigo|coral|amber|plum|ink} — anything else is a uniform
 *                         {@code 400}. This is <strong>not</strong> a free colour picker, so a
 *                         non-Paper theme can never be selected via this field.
 * @param themeSketchy     whether the hand-drawn wavy/sketchy wobble is on (TM-529); {@code true} =
 *                         wobble, {@code false} = clean Paper
 */
public record UpdateMeRequest(
        @Size(max = 255) String displayName,
        @Size(max = 255) String firstName,
        @Size(max = 255) String lastName,
        @Size(max = 255) String city,
        @Min(13) @Max(120) Integer age,
        @Size(max = 32) @Pattern(regexp = "^$|^\\+?[0-9 ()./-]{3,32}$", message = "must be a valid phone number")
                String phone,
        NotificationPref notificationPref,
        @Size(max = 64) String timezone,
        @Size(max = 35) String locale,
        @Pattern(regexp = "^(teal|indigo|coral|amber|plum|ink)$", message = "must be a valid accent swatch")
                String themeAccent,
        Boolean themeSketchy) {}
