package com.teammarhaba.backend.api;

import com.teammarhaba.backend.user.NotificationPref;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * Body for {@code PATCH /api/v1/me} (TM-112, extended in TM-162). Only the user-editable profile
 * fields — identity ({@code uid}/{@code email}) comes from the verified token and can never be set
 * here. Every field is optional; a {@code null} leaves that field unchanged (partial PATCH
 * semantics), so a caller can update one field without resending the rest.
 *
 * <p>Validation is deliberately lenient at the edges (TM-162):
 *
 * <ul>
 *   <li>{@code age} — bounded to the platform age band, 18–99 (TM-884; was 13–120). Enforced on
 *       <em>new saves/edits only</em>: existing under-18 accounts are grandfathered — nothing
 *       rejects them on read, and a PATCH that omits {@code age} (the client omits an unchanged
 *       value) leaves the stored value untouched.
 *   <li>{@code firstName}/{@code lastName}/{@code city} — name-like text (TM-771): must contain at
 *       least one letter (any script), and only letters, combining marks, spaces, hyphens,
 *       apostrophes and periods are allowed — a purely numeric value can no longer persist as a
 *       name or city. An empty string is accepted (clear/leave blank), consistent with
 *       {@code phone}. Mirrored client-side in {@code profile-core.js} {@code nameFormatError}.
 *       {@code city} is additionally constrained to the allowed city list (TM-877) in
 *       {@link com.teammarhaba.backend.user.UserService}, which needs the stored row: a NEW city
 *       value must come from the list, but the caller's already-saved off-list city is preserved
 *       (re-sending it unchanged is accepted), so no existing profile is invalidated.
 *   <li>{@code phone} — E.164-shaped (TM-781): a leading {@code +} is <em>required</em>, followed
 *       by 7–15 digits in total (the TM-752 length guard), with the long-accepted separator
 *       characters (space, {@code (}, {@code )}, {@code .}, {@code /}, {@code -}) allowed between
 *       digits only. The mandatory country picker composes {@code +<dial><national>} client-side,
 *       so a bare national number (no {@code +dial}) can only come from a stale/bypassing client
 *       and is rejected — it would be country-ambiguous and break the picker's round-trip split.
 *       We still do not attempt to verify a real, dialable number. An empty string is also
 *       accepted (clear/leave blank), consistent with the optional {@code @Size} text fields.
 *   <li>{@code notificationPref} — the {@link NotificationPref} enum; an unknown value is rejected
 *       by Jackson at deserialization time (uniform {@code 400}).
 *   <li>{@code timezone} (IANA id) and {@code locale} (BCP-47 tag) — best-effort validated in
 *       {@link com.teammarhaba.backend.user.UserService}, where {@link java.time.ZoneId}/
 *       {@link java.util.Locale} resolution is available.
 * </ul>
 *
 * @param displayName      the public display name
 * @param firstName        given name (name-like, TM-771)
 * @param lastName         family name (name-like, TM-771)
 * @param city             city name (name-like TM-771; allowed-list constrained TM-877 — see above)
 * @param age              age in years, 18–99 (TM-884; existing out-of-band values grandfathered)
 * @param phone            E.164-shaped phone: {@code +} then 7–15 digits, separators allowed
 *                         between digits (e.g. {@code +44 20 7946 0958}); {@code ""} clears
 * @param notificationPref delivery preference (EMAIL/PUSH/BOTH)
 * @param timezone         IANA timezone id, e.g. {@code Europe/London}
 * @param locale           BCP-47 language tag, e.g. {@code en-GB}
 * @param themeAccent      the chosen Paper accent swatch id (TM-529). A fixed curated palette:
 *                         {@code teal|indigo|coral|amber|plum|ink} — anything else is a uniform
 *                         {@code 400}. This is <strong>not</strong> a free colour picker, so a
 *                         non-Paper theme can never be selected via this field.
 * @param themeSketchy     whether the hand-drawn wavy/sketchy wobble is on (TM-529); {@code true} =
 *                         wobble, {@code false} = clean Paper
 * @param interests        the caller's chosen interest labels (TM-775, closes TM-514).
 *                         <strong>Full-set replace</strong>: a non-null list is the user's complete
 *                         new selection — the saved set is replaced with it. {@code null}/omitted
 *                         leaves the saved interests unchanged (partial-PATCH, like every other field
 *                         here). Each entry must be a <em>current active</em> catalogue label or the
 *                         whole PATCH is a uniform {@code 400}; the count is enforced against the
 *                         configured min/max ({@code InterestSelectionConfig}, default 1–3) server-side
 *                         in {@link com.teammarhaba.backend.user.UserService}, since bean validation
 *                         can't read the DB-backed bounds. The element-level {@code @NotBlank}/
 *                         {@code @Size} rejects a blank/over-long label at the boundary; the outer
 *                         {@code @Size(max = 50)} is a coarse abuse guard only.
 */
public record UpdateMeRequest(
        @Size(max = 255) String displayName,
        @Size(max = 255) @Pattern(regexp = NAME_LIKE, message = NAME_LIKE_MESSAGE) String firstName,
        @Size(max = 255) @Pattern(regexp = NAME_LIKE, message = NAME_LIKE_MESSAGE) String lastName,
        @Size(max = 255) @Pattern(regexp = NAME_LIKE, message = NAME_LIKE_MESSAGE) String city,
        @Min(18) @Max(99) Integer age,
        // Regex anatomy (TM-781): "^$|" keeps the empty-string clear alternative; then a MANDATORY
        // "+", a first digit, and 6–14 further digits each optionally preceded by separator chars —
        // i.e. 7–15 digits total with separators only BETWEEN digits (never leading or trailing).
        // @Size(max = 32) still bounds the overall separator-padded length.
        @Size(max = 32)
                @Pattern(
                        regexp = "^$|^\\+[0-9](?:[ ()./-]*[0-9]){6,14}$",
                        message = "must be a valid phone number")
                String phone,
        NotificationPref notificationPref,
        @Size(max = 64) String timezone,
        @Size(max = 35) String locale,
        @Pattern(regexp = "^(teal|indigo|coral|amber|plum|ink)$", message = "must be a valid accent swatch")
                String themeAccent,
        Boolean themeSketchy,
        @Size(max = 50, message = "too many interests") List<@NotBlank @Size(max = 120) String> interests) {

    /**
     * The TM-771 name-like rule shared by {@code firstName}/{@code lastName}/{@code city}: at least
     * one letter (any script — the lookahead), and only letters, combining marks, spaces, hyphens,
     * apostrophes and periods. {@code ^$} keeps the empty-string clear semantics.
     */
    static final String NAME_LIKE = "^$|^(?=.*\\p{L})[\\p{L}\\p{M} .'’-]+$";

    static final String NAME_LIKE_MESSAGE =
            "must contain letters (spaces, hyphens, apostrophes and periods are allowed)";
}
