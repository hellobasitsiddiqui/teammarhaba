package com.teammarhaba.backend.auth;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.UserInfo;
import com.google.firebase.auth.UserRecord;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/**
 * Reads the Firebase-owned {@link AccountState} for a uid <strong>live</strong> at request time, for
 * {@code GET /api/v1/me} (TM-164). One Admin-SDK {@link FirebaseAuth#getUser(String)} call yields
 * email-verified, MFA-enrolled, phone-verified, photo URL, and last-login — none of which we store;
 * Firebase stays the source of truth (the same rule the resend-verification path follows, TM-165).
 *
 * <p><strong>Best-effort by design.</strong> Resolving Firebase is what costs a network round trip
 * and needs credentials. {@link FirebaseAuth} is pulled lazily via an {@link ObjectProvider}
 * (matching {@link RoleService} / {@link EmailVerificationService}), and <em>any</em> failure to read
 * — no Admin SDK bean (dev/test/CI without ADC), the user not being found, or an SDK error — degrades
 * to {@link AccountState#unknown()} rather than failing {@code /me}. That keeps {@code /me} working
 * credential-free and means a transient identity-provider blip downgrades badges instead of 500-ing
 * the caller's own profile.
 *
 * <p><strong>Cost.</strong> This adds exactly one Admin-SDK {@code getUser} per {@code GET /me}
 * (a network call to Firebase). Acceptable for a per-user self-read; if {@code /me} ever becomes
 * hot, a short-TTL per-uid cache is the obvious follow-up.
 *
 * <p><strong>MFA note.</strong> firebase-admin 9.4.1's {@link UserRecord} exposes no typed
 * {@code getMultiFactor()} accessor, so an enrolled second factor is detected from
 * {@link UserRecord#getProviderData()}: a {@code "phone"} provider entry present alongside a
 * non-phone primary provider indicates phone-based MFA enrolment. This is conservative — it can
 * only report what the Admin SDK surfaces — and is the single place to revisit if the SDK gains a
 * first-class multi-factor API.
 */
@Service
public class FirebaseAccountStateService {

    private static final Logger log = LoggerFactory.getLogger(FirebaseAccountStateService.class);

    /** Firebase provider id for a phone identity / phone-based second factor. */
    private static final String PHONE_PROVIDER = "phone";

    private final ObjectProvider<FirebaseAuth> firebaseAuth;

    public FirebaseAccountStateService(ObjectProvider<FirebaseAuth> firebaseAuth) {
        this.firebaseAuth = firebaseAuth;
    }

    /**
     * Read the live Firebase state for {@code uid}. Never throws: any inability to read (no creds,
     * user absent, SDK error) returns {@link AccountState#unknown()} so {@code /me} still succeeds.
     */
    public AccountState forUid(String uid) {
        try {
            FirebaseAuth auth = firebaseAuth.getIfAvailable();
            if (auth == null) {
                // No Admin SDK bean wired (dev/test/CI without ADC) — degrade, don't fail /me.
                return AccountState.unknown();
            }
            UserRecord user = auth.getUser(uid);
            return new AccountState(
                    user.isEmailVerified(),
                    mfaEnabled(user),
                    user.getPhoneNumber() != null, // Firebase only stores verified phone numbers
                    user.getPhotoUrl(),
                    lastLoginAt(user));
        } catch (Exception ex) {
            // Don't let an identity-provider blip take down the caller's own /me — degrade to unknown.
            log.warn("Could not read Firebase account state for uid {} — returning unknown state.", uid, ex);
            return AccountState.unknown();
        }
    }

    /**
     * Detect an enrolled multi-factor (second factor). With no typed {@code getMultiFactor()} on
     * {@link UserRecord} in this SDK version, an enrolled phone second factor surfaces as a
     * {@code "phone"} entry in {@link UserRecord#getProviderData()} alongside a non-phone primary
     * provider — that combination is what we report as MFA.
     */
    private static boolean mfaEnabled(UserRecord user) {
        UserInfo[] providers = user.getProviderData();
        if (providers == null || providers.length == 0) {
            return false;
        }
        boolean hasPhoneFactor = false;
        boolean hasNonPhonePrimary = false;
        for (UserInfo provider : providers) {
            if (PHONE_PROVIDER.equals(provider.getProviderId())) {
                hasPhoneFactor = true;
            } else {
                hasNonPhonePrimary = true;
            }
        }
        return hasPhoneFactor && hasNonPhonePrimary;
    }

    /** Last Firebase sign-in as an {@link Instant}, or {@code null} if Firebase reports none (0). */
    private static Instant lastLoginAt(UserRecord user) {
        if (user.getUserMetadata() == null) {
            return null;
        }
        long lastSignIn = user.getUserMetadata().getLastSignInTimestamp();
        return lastSignIn > 0 ? Instant.ofEpochMilli(lastSignIn) : null;
    }
}
