package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.AccountState;
import com.teammarhaba.backend.user.NotificationPref;
import java.time.Instant;

/**
 * The authenticated caller's profile, returned by {@code GET /api/v1/me}. Identity ({@code uid}/
 * {@code email}) comes from the verified token; the rest is the persisted, user-editable profile
 * (TM-112, extended with real profile details in TM-162) plus the account-lifecycle flags (TM-163).
 * Unfilled fields are {@code null}.
 *
 * @param uid                  the Firebase UID (always present on a verified token)
 * @param email                the caller's email if the token carries one (may be {@code null})
 * @param displayName          the profile name — {@code null} until the persisted profile lands (TM-112)
 * @param firstName            given name (may be {@code null})
 * @param lastName             family name (may be {@code null})
 * @param city                 free-text city (may be {@code null})
 * @param age                  age in years (may be {@code null})
 * @param phone                phone number (may be {@code null})
 * @param notificationPref     delivery preference — new accounts default to {@code BOTH} (email + push, TM-427)
 * @param timezone             IANA timezone id (may be {@code null})
 * @param locale               BCP-47 language tag (may be {@code null})
 * @param role                 the caller's role — defaults to {@code "USER"} until claims land (TM-110)
 * @param onboardingCompleted  whether first-run onboarding is finished (TM-163); defaults to {@code false}
 * @param termsAcceptedVersion the terms version the user accepted (TM-163), or {@code null} if never
 * @param termsAcceptedAt      when that terms version was accepted (TM-163), or {@code null} if never
 * @param currentTermsVersion  the <strong>currently published</strong> terms version (TM-170), from the
 *                             {@code app.terms.current-version} config constant. The client gates the app
 *                             whenever this differs from {@code termsAcceptedVersion} (never-accepted or a
 *                             newer version bumped), forcing (re-)acceptance. Always present.
 * @param ageVerified          whether the user has self-attested their age (TM-163); defaults to {@code false}
 * @param accountState         read-only account state sourced live from Firebase (TM-164): email/phone
 *                             verified, MFA enrolled, photo URL, last login. Never our own truth — read
 *                             from the Admin SDK at request time, not stored. Fields are {@code null} if
 *                             Firebase state can't be read (e.g. credential-free dev/test).
 * @param lastActiveAt         when the account last made an authenticated {@code /me} call (TM-164);
 *                             <strong>our</strong> DB column, stamped on every authenticated read.
 *                             {@code null} only before the very first such call.
 * @param lateCancelCount      running count of the account's late event cancellations (TM-414) —
 *                             un-RSVPs made inside an event's cancellation window. Exposed so the
 *                             client (and later TM-409 / admin) can build on it; {@code 0} until the
 *                             first late cancel. No consequence is enforced on it yet.
 * @param themeAccent          the chosen Paper accent swatch id (TM-529) — one of the curated palette
 *                             ids; {@code teal} (the default swatch) for a brand-new account
 * @param themeSketchy         whether the hand-drawn wavy/sketchy wobble is on (TM-529); {@code true}
 *                             (wobble) for a brand-new account, {@code false} = clean Paper
 */
public record MeResponse(
        String uid,
        String email,
        String displayName,
        String firstName,
        String lastName,
        String city,
        Integer age,
        String phone,
        NotificationPref notificationPref,
        String timezone,
        String locale,
        String role,
        boolean onboardingCompleted,
        String termsAcceptedVersion,
        Instant termsAcceptedAt,
        String currentTermsVersion,
        boolean ageVerified,
        AccountState accountState,
        Instant lastActiveAt,
        int lateCancelCount,
        String themeAccent,
        boolean themeSketchy) {}
