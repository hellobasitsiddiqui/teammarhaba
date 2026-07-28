package com.teammarhaba.backend.api;

import com.teammarhaba.backend.user.Gender;
import com.teammarhaba.backend.user.NotificationPref;
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
 *       <em>new saves/edits only</em>, in {@link com.teammarhaba.backend.user.UserService} behind
 *       the unchanged-value guard (TM-900) rather than here: bean validation would run BEFORE the
 *       service's {@code Objects.equals} no-op check, so an API client re-sending an unchanged
 *       grandfathered age (e.g. a 13–120-era 15) would be 400ed out of saving anything. Existing
 *       out-of-band accounts are grandfathered — nothing rejects them on read, an unchanged
 *       re-send is a no-op, and a PATCH that omits {@code age} (the web client omits an unchanged
 *       value) leaves the stored value untouched. A NEW value must be 18–99.
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
 *   <li>{@code gender} — the {@link Gender} enum (TM-955), editable here after onboarding; an unknown
 *       value is rejected by Jackson at deserialization time (uniform {@code 400}). Optional like
 *       every field here: {@code null}/omitted leaves the stored gender unchanged (partial PATCH).
 *       There is no empty-string "clear" — gender is a closed enum, not free text; a user changes it
 *       between the three buckets (including {@code PREFER_NOT_TO_SAY}) but the edit form never sends
 *       a "no gender" value.</li>
 *   <li>{@code nationality} — an ISO-3166 alpha-2 country code (TM-1134). The boundary {@code @Pattern}
 *       enforces only the coarse shape (blank, or two ASCII letters); whether the code names a REAL
 *       country is checked in {@link com.teammarhaba.backend.user.UserService} against the known-code
 *       set, behind the unchanged-value guard — a NEW code must be recognised, but the caller's
 *       already-saved code (or {@code ""}) re-sends as a no-op, so no existing profile is invalidated.
 *       Optional partial-PATCH: {@code null}/omitted leaves it unchanged, {@code ""} clears it.</li>
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
 * @param age              age in years, 18–99 for new values (TM-884; band enforced in the service
 *                         behind the unchanged-guard, TM-900 — grandfathered values re-send fine)
 * @param gender           self-reported gender (TM-955): FEMALE / MALE / PREFER_NOT_TO_SAY; optional
 *                         partial-PATCH ({@code null}/omitted leaves it unchanged)
 * @param nationality      self-reported nationality (TM-1134) as an ISO-3166 alpha-2 code (e.g.
 *                         {@code GB}); optional partial-PATCH ({@code null}/omitted leaves it
 *                         unchanged, {@code ""} clears). A NEW value must be a recognised country
 *                         code (validated in the service like {@code city}); an unchanged saved code
 *                         re-sends as a no-op
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
        // No @Min/@Max here (TM-900): the 18–99 band is enforced in UserService.updateProfile BEHIND
        // the Objects.equals unchanged-guard, so an unchanged grandfathered age re-sends as a no-op.
        Integer age,
        // TM-955: the self-reported gender bucket. A closed Gender enum, so Jackson rejects an unknown
        // value with a uniform 400 at deserialization; null/omitted leaves it unchanged (partial PATCH).
        Gender gender,
        // TM-1134: self-reported nationality as an ISO-3166 alpha-2 code (e.g. "GB"). Optional partial
        // PATCH — null/omitted leaves it unchanged; "" clears it. The boundary @Pattern only enforces
        // the coarse SHAPE (blank, or exactly two ASCII letters); the real "is a KNOWN country code"
        // check lives in UserService.updateProfile behind the Objects.equals no-op guard (mirroring
        // city, TM-877), so an unchanged saved code re-sends as a no-op and only a NEW value must be a
        // recognised code.
        @Pattern(regexp = NATIONALITY_PATTERN, message = NATIONALITY_MESSAGE) String nationality,
        // Regex anatomy (TM-781): "^$|" keeps the empty-string clear alternative; then a MANDATORY
        // "+", a first digit, and 6–14 further digits each optionally preceded by separator chars —
        // i.e. 7–15 digits total with separators only BETWEEN digits (never leading or trailing).
        // @Size(max = 32) still bounds the overall separator-padded length.
        @Size(max = 32)
                @Pattern(regexp = PHONE_PATTERN, message = PHONE_MESSAGE)
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

    /**
     * The TM-781 E.164 stored-shape rule shared with {@link AdminUpdateProfileRequest#phone} so the
     * admin edit can never fork a weaker/older phone rule: {@code "^$|"} keeps the empty-string clear
     * alternative; then a MANDATORY {@code "+"}, a first digit, and 6–14 further digits each optionally
     * preceded by separator chars — i.e. 7–15 digits total with separators only BETWEEN digits.
     */
    static final String PHONE_PATTERN = "^$|^\\+[0-9](?:[ ()./-]*[0-9]){6,14}$";

    static final String PHONE_MESSAGE = "must be a valid phone number";

    /**
     * The TM-1134 nationality boundary SHAPE rule: blank (leave/clear), or exactly two ASCII letters
     * (an ISO-3166 alpha-2 code, any case). This is only the coarse shape — whether the two letters
     * name a REAL country is checked in {@link com.teammarhaba.backend.user.UserService} against the
     * known-code set, behind the unchanged-value guard, exactly like the {@code city} allow-list.
     */
    static final String NATIONALITY_PATTERN = "^$|^[A-Za-z]{2}$";

    static final String NATIONALITY_MESSAGE = "must be a valid country code";
}
