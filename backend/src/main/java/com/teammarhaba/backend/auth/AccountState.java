package com.teammarhaba.backend.auth;

import java.time.Instant;

/**
 * The Firebase-owned, read-only account state surfaced on {@code GET /api/v1/me} (TM-164).
 *
 * <p>Every field here is read <strong>live from Firebase</strong> at request time (via the Admin SDK
 * {@link com.google.firebase.auth.FirebaseAuth#getUser(String)}) and is deliberately <em>never</em>
 * persisted in our {@code users} table — Firebase stays the single source of truth, exactly as the
 * email-verification path already treats {@code emailVerified} (TM-165). The client uses these to
 * render verification/activity badges; it must not treat them as our truth.
 *
 * <p>All fields are best-effort: if the Admin SDK is unavailable (dev/test/CI without credentials)
 * or the lookup fails, an {@linkplain #unknown() empty} state is returned rather than failing
 * {@code /me}, so the endpoint keeps working credential-free.
 *
 * @param emailVerified whether Firebase considers the caller's email verified, or {@code null} if
 *     the state could not be read
 * @param mfaEnabled    whether the caller has a multi-factor (second factor) enrolled, or
 *     {@code null} if unknown
 * @param phoneVerified whether the caller has a verified phone number on file (Firebase only stores
 *     verified numbers), or {@code null} if unknown
 * @param photoURL      the caller's Firebase profile photo URL (set by TM-166), or {@code null} if
 *     none/unknown
 * @param lastLoginAt   the caller's last Firebase sign-in time, or {@code null} if unknown
 */
public record AccountState(
        Boolean emailVerified, Boolean mfaEnabled, Boolean phoneVerified, String photoURL, Instant lastLoginAt) {

    /** The all-{@code null} state used when Firebase state can't be read (no creds / lookup failed). */
    public static AccountState unknown() {
        return new AccountState(null, null, null, null, null);
    }
}
