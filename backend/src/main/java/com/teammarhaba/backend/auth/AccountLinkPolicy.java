package com.teammarhaba.backend.auth;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.UserInfo;
import com.google.firebase.auth.UserRecord;
import java.util.Locale;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/**
 * The <strong>proof-of-both</strong> gate for multi-provider account convergence (TM-990, split (b)
 * of TM-306).
 *
 * <p><strong>The takeover hole this closes.</strong> A person may sign in three ways — email-code,
 * SMS phone, Google — and Firebase mints a <em>separate</em> uid per provider unless the accounts
 * are explicitly linked. The product wants those to converge onto ONE account. The naive way to
 * converge is to merge two identities the moment a shared identifier (an email string, a phone
 * number) matches. That is an <strong>account-takeover vector</strong>: an attacker who merely
 * <em>claims</em> your email on a second, unverified Firebase account would be silently merged into
 * <em>your</em> account. So convergence must never happen on an UNVERIFIED match.
 *
 * <p><strong>The rule (groomed 2026-07-22, baked into TM-990).</strong> LINK on collision, but ONLY
 * with proof of control of BOTH identifiers — e.g. the user verifies the second identifier (an SMS
 * OTP) <em>while signed into</em> the first account, exactly the {@code linkWithCredential} flow the
 * client already drives for phone→account linking (auth.js {@code confirmPhoneLink}, TM-930). Absent
 * that proof, the two identities stay SEPARATE and the collision is surfaced as a hard-block, never a
 * silent merge.
 *
 * <p>This service is the <strong>server-side oracle</strong> for that rule: given a signed-in uid
 * (the "primary" the caller has already authenticated as) and a candidate identifier they want to
 * bind to it, it answers whether the bind is <em>proven</em>. "Proven" means Firebase itself already
 * records the candidate as a verified provider on that same uid — i.e. the OTP link has completed and
 * Firebase, the identity source of truth, attests both. It NEVER treats a bare string match against
 * some <em>other</em> account as proof.
 *
 * <p><strong>Fail-closed</strong> (mirrors {@link VerifiedPhoneService}, not the degrade-to-unknown
 * {@link FirebaseAccountStateService}): a security decision must refuse when it cannot read the
 * truth. No Admin SDK bean, an absent user, or an SDK error all resolve to
 * {@link LinkDecision#REFUSE_UNVERIFIED} — a broken read must never be mistaken for "proof present".
 *
 * <p><strong>Credential-free boot preserved.</strong> {@link FirebaseAuth} is pulled lazily via an
 * {@link ObjectProvider} (copied from {@link VerifiedPhoneService} / {@link
 * FirebaseAccountStateService}), so nothing eager touches ADC at startup and dev/test/CI boot without
 * credentials.
 */
@Service
public class AccountLinkPolicy {

    private static final Logger log = LoggerFactory.getLogger(AccountLinkPolicy.class);

    /** Firebase provider id for a phone identity. */
    static final String PHONE_PROVIDER = "phone";

    private final ObjectProvider<FirebaseAuth> firebaseAuth;

    public AccountLinkPolicy(ObjectProvider<FirebaseAuth> firebaseAuth) {
        this.firebaseAuth = firebaseAuth;
    }

    /**
     * The outcome of a proof-of-both check.
     *
     * <ul>
     *   <li>{@link #LINK} — Firebase attests the candidate is a verified provider on the SAME uid the
     *       caller is signed in as: proof of both, converge.</li>
     *   <li>{@link #REFUSE_UNVERIFIED} — no such proof (or the read failed): keep the identities
     *       separate. The caller surfaces the hard-block / routes the user through the proven
     *       verify-while-signed-in link flow — it must NEVER silently merge.</li>
     * </ul>
     */
    public enum LinkDecision {
        LINK,
        REFUSE_UNVERIFIED
    }

    /**
     * Whether binding {@code candidateEmail} to the signed-in {@code uid} is PROVEN — i.e. Firebase
     * already records that email as verified on that uid. This is the safe convergence signal for the
     * email-code path: the OTP the user just passed proves control of the email, and Firebase's own
     * record confirms it belongs to this uid.
     *
     * @param uid            the caller's signed-in Firebase uid (from the verified token, never client input)
     * @param candidateEmail the email the caller wants treated as belonging to that account
     * @return {@link LinkDecision#LINK} only when Firebase attests the email is verified on this uid
     */
    public LinkDecision decideEmailLink(String uid, String candidateEmail) {
        String wanted = normaliseEmail(candidateEmail);
        if (wanted.isEmpty()) {
            return LinkDecision.REFUSE_UNVERIFIED;
        }
        UserRecord record = readUser(uid);
        if (record == null) {
            // Fail closed: an unreadable identity provider is a refusal, never a silent pass.
            return LinkDecision.REFUSE_UNVERIFIED;
        }
        // Proof = Firebase says THIS uid owns THIS email AND has verified it. A verified email is one
        // the user has demonstrably controlled (clicked the link / passed the OTP that set the flag).
        boolean sameEmail = wanted.equals(normaliseEmail(record.getEmail()));
        if (sameEmail && record.isEmailVerified()) {
            return LinkDecision.LINK;
        }
        // Also accept the email appearing as a verified provider entry (e.g. Google/password provider
        // carrying the same address), which is equally proof Firebase holds it against this uid.
        if (hasVerifiedProviderEmail(record, wanted)) {
            return LinkDecision.LINK;
        }
        log.info("Refusing email link for uid (email not verified on this account) — no auto-merge.");
        return LinkDecision.REFUSE_UNVERIFIED;
    }

    /**
     * Whether binding {@code candidatePhoneE164} to the signed-in {@code uid} is PROVEN — i.e.
     * Firebase already records that phone as a verified provider on that uid (which is only ever true
     * once the SMS-OTP {@code linkWithCredential} has completed on that account; Firebase stores a
     * phone only when verified). The safe convergence signal for the phone path.
     *
     * @param uid                the caller's signed-in Firebase uid (from the verified token)
     * @param candidatePhoneE164 the phone the caller wants treated as belonging to that account
     * @return {@link LinkDecision#LINK} only when Firebase attests the phone is verified on this uid
     */
    public LinkDecision decidePhoneLink(String uid, String candidatePhoneE164) {
        String wanted = normalisePhone(candidatePhoneE164);
        if (wanted.isEmpty()) {
            return LinkDecision.REFUSE_UNVERIFIED;
        }
        UserRecord record = readUser(uid);
        if (record == null) {
            return LinkDecision.REFUSE_UNVERIFIED; // fail closed
        }
        // Firebase only ever stores a phone number it has verified (OTP-linked), so a matching number
        // on the record — whether the primary phoneNumber or a "phone" provider entry — is proof the
        // caller controls it AND that it is bound to this uid.
        if (wanted.equals(normalisePhone(record.getPhoneNumber()))) {
            return LinkDecision.LINK;
        }
        UserInfo[] providers = record.getProviderData();
        if (providers != null) {
            for (UserInfo provider : providers) {
                if (PHONE_PROVIDER.equals(provider.getProviderId())
                        && wanted.equals(normalisePhone(provider.getPhoneNumber()))) {
                    return LinkDecision.LINK;
                }
            }
        }
        log.info("Refusing phone link for uid (phone not verified on this account) — no auto-merge.");
        return LinkDecision.REFUSE_UNVERIFIED;
    }

    /** Read the Firebase record for a uid; {@code null} on any failure (caller fails closed). */
    private UserRecord readUser(String uid) {
        try {
            FirebaseAuth auth = firebaseAuth.getIfAvailable();
            if (auth == null) {
                // No Admin SDK bean (dev/test/CI without ADC). A security decision fails closed.
                log.warn("Account-link check requested but no Firebase Admin SDK is available — refusing (uid {}).", uid);
                return null;
            }
            return auth.getUser(uid);
        } catch (Exception ex) {
            // Fail closed: an identity-provider error refuses the link, never waves it through.
            log.warn("Could not read Firebase record for uid {} during account-link check — refusing.", uid, ex);
            return null;
        }
    }

    /** True iff any provider entry on the record carries {@code wantedEmail} as a verified email. */
    private static boolean hasVerifiedProviderEmail(UserRecord record, String wantedEmail) {
        UserInfo[] providers = record.getProviderData();
        if (providers == null) {
            return false;
        }
        for (UserInfo provider : providers) {
            // A provider entry only appears once that provider has authenticated the user, so an email
            // carried on it is one Firebase has seen the user prove control of via that provider.
            if (wantedEmail.equals(normaliseEmail(provider.getEmail()))) {
                return true;
            }
        }
        return false;
    }

    private static String normaliseEmail(String email) {
        return email == null ? "" : email.trim().toLowerCase(Locale.ROOT);
    }

    /**
     * Compare phones on digits only — the same normalisation the DB uniqueness index uses
     * ({@code V48__dedup_phone_and_unique_index}: {@code regexp_replace(phone, '[^0-9]', '', 'g')}),
     * so "+44 7700 900123" and "+447700900123" are one number here too.
     */
    private static String normalisePhone(String phone) {
        return phone == null ? "" : phone.replaceAll("[^0-9]", "");
    }
}
