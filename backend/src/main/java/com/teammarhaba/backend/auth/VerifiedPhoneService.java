package com.teammarhaba.backend.auth;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.UserRecord;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/**
 * Reads the Firebase-<strong>verified</strong> phone number for a uid, server-side, via the Admin
 * SDK — the trusted source for enforcement on the onboarding transitions (TM-931, subticket B of
 * TM-923). One {@link FirebaseAuth#getUser(String)} call yields {@link UserRecord#getPhoneNumber()};
 * <em>Firebase only ever stores a verified (OTP-linked) phone</em>, so a non-null value here is a
 * number the caller has proven they control. The backend trusts only this value, never a
 * client-supplied one.
 *
 * <p><strong>Fail closed (unlike {@link FirebaseAccountStateService}).</strong> That service backs
 * {@code GET /me} and deliberately <em>degrades to unknown</em> on any read failure so a profile read
 * never 500s. Enforcement has the opposite requirement: when the flag is on, an inability to read the
 * verified phone (no Admin SDK bean, the user absent, an SDK error) must <em>refuse</em> the
 * transition — a broken read must never be mistaken for "no verified phone required". So
 * {@link #requireVerifiedPhone(String)} throws {@link VerifiedPhoneUnavailableException} on any read
 * failure or a null/blank phone.
 *
 * <p><strong>Credential-free boot preserved.</strong> {@link FirebaseAuth} is resolved lazily via an
 * {@link ObjectProvider} (copied from {@link FirebaseAccountStateService}) so nothing eager touches
 * ADC at startup. Callers gate on the {@code app.phone.require-verified} flag and only invoke this
 * when the flag is on — when the flag is off, Firebase is never touched on the onboarding paths.
 */
@Service
public class VerifiedPhoneService {

    private static final Logger log = LoggerFactory.getLogger(VerifiedPhoneService.class);

    private final ObjectProvider<FirebaseAuth> firebaseAuth;

    public VerifiedPhoneService(ObjectProvider<FirebaseAuth> firebaseAuth) {
        this.firebaseAuth = firebaseAuth;
    }

    /**
     * The caller's Firebase-verified E.164 phone, or throw if it cannot be established.
     *
     * <p>Fail-closed for enforcement: a missing Admin SDK bean, an absent user, an SDK error, or a
     * null/blank phone all raise {@link VerifiedPhoneUnavailableException}. Only a genuinely present,
     * non-blank verified number returns normally.
     *
     * @param uid the caller's Firebase uid (from the verified token, never client input)
     * @return the verified E.164 phone number
     * @throws VerifiedPhoneUnavailableException if no verified phone can be read for the uid
     */
    public String requireVerifiedPhone(String uid) {
        return readVerifiedPhone(uid)
                .orElseThrow(() -> new VerifiedPhoneUnavailableException(
                        "No verified phone number is on the caller's Firebase account."));
    }

    /**
     * The caller's Firebase-verified phone as an {@link Optional} — empty when Firebase reports no
     * verified phone, throwing only when the read itself fails (fail-closed). Kept separate from
     * {@link #requireVerifiedPhone} so the caller can distinguish "read succeeded, no phone" from
     * "read failed" if ever needed; today both are refusals for enforcement.
     */
    private Optional<String> readVerifiedPhone(String uid) {
        FirebaseAuth auth = firebaseAuth.getIfAvailable();
        if (auth == null) {
            // No Admin SDK bean (dev/test/CI without ADC). Under enforcement this is a refusal, not a
            // silent pass — the whole point is that a caller can't complete onboarding on the strength
            // of an unreadable identity provider.
            log.warn("Verified-phone enforcement is on but no Firebase Admin SDK is available — refusing (uid {}).", uid);
            throw new VerifiedPhoneUnavailableException("Firebase Admin SDK is not available to verify the phone.");
        }
        try {
            UserRecord user = auth.getUser(uid);
            String phone = user.getPhoneNumber(); // Firebase only stores verified phone numbers
            if (phone == null || phone.isBlank()) {
                return Optional.empty();
            }
            return Optional.of(phone.trim());
        } catch (Exception ex) {
            // Fail closed: an identity-provider error must refuse the transition, never wave it through.
            log.warn("Could not read Firebase verified phone for uid {} — failing closed (refusing).", uid, ex);
            throw new VerifiedPhoneUnavailableException("Could not read the verified phone from Firebase.", ex);
        }
    }
}
