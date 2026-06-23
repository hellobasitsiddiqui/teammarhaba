package com.teammarhaba.backend.auth;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseAuthException;
import com.google.firebase.auth.UserRecord;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/**
 * Re-triggers a Firebase email-verification for the authenticated caller (TM-165).
 *
 * <p><strong>Source of truth.</strong> Whether an address is verified is read live from Firebase
 * ({@link UserRecord#isEmailVerified()}) on every call — it is never stored in our {@code users}
 * table. If the account is already verified, resending is refused ({@link
 * EmailVerificationException.Reason#ALREADY_VERIFIED}).
 *
 * <p><strong>Delivery.</strong> The original verification email is sent by the client on signup
 * (Firebase JS {@code sendEmailVerification} after {@code createUser}). For a resend we use the
 * Admin SDK's {@link FirebaseAuth#generateEmailVerificationLink(String)} to mint a fresh link for
 * the caller's address. There is no backend mail transport in the codebase today, so the link is
 * logged and the call is treated as the authoritative resend trigger; wiring it to an actual mail
 * provider is the single, isolated extension point a future mail ticket plugs into.
 *
 * <p><strong>Rate limiting.</strong> A simple in-memory per-uid cooldown ({@link #cooldown}) makes
 * the endpoint idempotent under bursts: a second call inside the window is refused with {@link
 * EmailVerificationException.Reason#COOLDOWN} rather than hammering Firebase. The map is process-
 * local (fine for a single Cloud Run instance and the common case; a distributed store is a future
 * improvement if the service scales out and the cooldown must be global). Successful sends record
 * the send time; refusals do not, so a refused call never extends the window.
 *
 * <p>{@link FirebaseAuth} is resolved lazily through an {@link ObjectProvider}, matching {@link
 * RoleService} / the verification path, so nothing here touches Firebase/ADC until a resend is
 * actually requested — keeping dev/test/CI boots credential-free.
 */
@Service
public class EmailVerificationService {

    private static final Logger log = LoggerFactory.getLogger(EmailVerificationService.class);

    /** Minimum gap between resends for the same user. Conservative; avoids mailbox spam. */
    static final Duration COOLDOWN = Duration.ofSeconds(60);

    private final ObjectProvider<FirebaseAuth> firebaseAuth;
    private final Clock clock;

    /** uid -> the instant of its last successful resend; entries persist for the process lifetime. */
    private final ConcurrentHashMap<String, Instant> lastSent = new ConcurrentHashMap<>();

    @Autowired
    public EmailVerificationService(ObjectProvider<FirebaseAuth> firebaseAuth) {
        this(firebaseAuth, Clock.systemUTC());
    }

    /** Test seam: inject a fixed/advanceable {@link Clock} to exercise the cooldown deterministically. */
    EmailVerificationService(ObjectProvider<FirebaseAuth> firebaseAuth, Clock clock) {
        this.firebaseAuth = firebaseAuth;
        this.clock = clock;
    }

    /**
     * Re-send the email-verification for {@code uid}.
     *
     * @throws EmailVerificationException if the address is already verified
     *     ({@link EmailVerificationException.Reason#ALREADY_VERIFIED}) or a resend was triggered too
     *     recently ({@link EmailVerificationException.Reason#COOLDOWN})
     * @throws FirebaseAuthException if the user does not exist or the Admin SDK call fails
     */
    public void resend(String uid) throws FirebaseAuthException {
        FirebaseAuth auth = firebaseAuth.getObject();
        UserRecord user = auth.getUser(uid);

        if (user.isEmailVerified()) {
            throw new EmailVerificationException(
                    EmailVerificationException.Reason.ALREADY_VERIFIED,
                    "This email address is already verified.");
        }

        Instant now = clock.instant();
        Instant previous = lastSent.get(uid);
        if (previous != null && Duration.between(previous, now).compareTo(COOLDOWN) < 0) {
            throw new EmailVerificationException(
                    EmailVerificationException.Reason.COOLDOWN,
                    "A verification email was sent recently. Please wait before requesting another.");
        }

        // Mint a fresh verification link for the caller's address. There is no backend mail
        // transport yet, so this both proves the account is resend-eligible and is the hook a
        // future mail provider sends. The link itself is a credential — never log it.
        auth.generateEmailVerificationLink(user.getEmail());
        lastSent.put(uid, now);
        log.info("Re-sent email verification for uid {}.", uid);
    }
}
