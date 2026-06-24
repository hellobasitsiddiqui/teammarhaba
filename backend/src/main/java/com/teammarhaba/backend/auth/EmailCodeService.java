package com.teammarhaba.backend.auth;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseAuthException;
import com.google.firebase.auth.UserRecord;
import com.google.firebase.auth.UserRecord.CreateRequest;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/**
 * Passwordless email-code login (TM-234): the server generates a single-use numeric code, sends it
 * via the {@link EmailCodeMailer} seam (the email-verification mail path of TM-165), verifies it,
 * and on success mints a Firebase <strong>custom token</strong> the client exchanges for a normal
 * Firebase session. Backend ID-token verification (TM-79) is untouched — this only adds a new way to
 * obtain a session; the existing email+password path is unaffected.
 *
 * <p><strong>Why a custom token.</strong> Firebase has no native email-OTP. Verifying our own code
 * and then calling {@link FirebaseAuth#createCustomToken(String)} lets the client sign in
 * ({@code signInWithCustomToken}) and from there everything is a standard Firebase session — same
 * ID tokens, same backend verification. The user is looked up by email (or created on first sight,
 * matching Firebase's own passwordless behaviour), so an existing password user keeps the same uid.
 *
 * <p><strong>Code handling.</strong> The plaintext code is emailed and then immediately discarded —
 * only its SHA-256 hash is held, keyed by normalised email, so a memory/heap dump never reveals an
 * outstanding code. Each address has at most one outstanding code (a re-request replaces it). A code
 * is <em>single-use</em> (burned on the first correct verify), <em>short-lived</em> ({@link
 * EmailCodeProperties#ttl()}), and <em>attempt-capped</em> ({@link
 * EmailCodeProperties#maxVerifyAttempts()} wrong guesses burn it) to stop brute-forcing a short code.
 *
 * <p><strong>Rate limiting.</strong> {@code request} enforces a per-address send cooldown
 * ({@link EmailCodeProperties#sendCooldown()}) so the endpoint can't be used to spam an inbox or
 * enumerate accounts by timing; {@code verify} enforces the attempt cap. Both stores are process-
 * local {@link ConcurrentHashMap}s — fine for a single Cloud Run instance and the common case; a
 * distributed store (e.g. Redis) is the future improvement if the service scales out and the limits
 * must be global. (Same trade-off the TM-165 cooldown documents.)
 *
 * <p>{@link FirebaseAuth} is resolved lazily through an {@link ObjectProvider}, matching {@link
 * EmailVerificationService} / {@link RoleService}, so nothing here touches Firebase/ADC until a
 * login is actually attempted — keeping dev/test/CI boots credential-free.
 */
@Service
public class EmailCodeService {

    private static final Logger log = LoggerFactory.getLogger(EmailCodeService.class);

    private final ObjectProvider<FirebaseAuth> firebaseAuth;
    private final EmailCodeMailer mailer;
    private final EmailCodeProperties props;
    private final Clock clock;
    private final SecureRandom random = new SecureRandom();

    /** Normalised email -> the single outstanding code for that address. */
    private final ConcurrentHashMap<String, PendingCode> pending = new ConcurrentHashMap<>();

    /** Normalised email -> the instant of its last successful send; drives the send cooldown. */
    private final ConcurrentHashMap<String, Instant> lastSent = new ConcurrentHashMap<>();

    @Autowired
    public EmailCodeService(
            ObjectProvider<FirebaseAuth> firebaseAuth, EmailCodeMailer mailer, EmailCodeProperties props) {
        this(firebaseAuth, mailer, props, Clock.systemUTC());
    }

    /** Test seam: inject a fixed/advanceable {@link Clock} to exercise TTL + cooldown deterministically. */
    EmailCodeService(
            ObjectProvider<FirebaseAuth> firebaseAuth, EmailCodeMailer mailer, EmailCodeProperties props, Clock clock) {
        this.firebaseAuth = firebaseAuth;
        this.mailer = mailer;
        this.props = props;
        this.clock = clock;
    }

    /**
     * Generate and email a fresh login code for {@code rawEmail}. Replaces any outstanding code for
     * the address (so a "Resend" is just another request). Enforces the per-address send cooldown.
     *
     * <p>The response intentionally carries no signal about whether the address has an account — the
     * caller always sees the same outcome — so the endpoint can't enumerate users.
     *
     * @throws EmailCodeException with {@link EmailCodeException.Reason#SEND_RATE_LIMITED} if a code
     *     was requested for this address within the cooldown window
     */
    public void request(String rawEmail) {
        String email = normalise(rawEmail);
        Instant now = clock.instant();

        Instant previous = lastSent.get(email);
        if (previous != null && Duration.between(previous, now).compareTo(props.sendCooldown()) < 0) {
            throw new EmailCodeException(
                    EmailCodeException.Reason.SEND_RATE_LIMITED,
                    "A code was sent recently. Please wait before requesting another.");
        }

        String code = generateCode();
        pending.put(email, new PendingCode(hash(code), now.plus(props.ttl()), props.maxVerifyAttempts()));
        lastSent.put(email, now);

        // Hand the plaintext to the mailer and let it go out of scope — only the hash is retained.
        mailer.sendLoginCode(email, code);
        log.info("Issued a login code for an address (cooldown started).");
    }

    /**
     * Verify {@code rawCode} against the outstanding code for {@code rawEmail} and, on success, mint a
     * Firebase custom token for the address's account (creating the account on first sight, matching
     * Firebase passwordless). The code is single-use: a correct verify burns it.
     *
     * @return a Firebase custom token the client exchanges via {@code signInWithCustomToken}
     * @throws EmailCodeException for an invalid ({@link EmailCodeException.Reason#CODE_INVALID}),
     *     expired ({@link EmailCodeException.Reason#CODE_EXPIRED}), or attempt-exhausted
     *     ({@link EmailCodeException.Reason#VERIFY_RATE_LIMITED}) code
     * @throws FirebaseAuthException if the Admin SDK lookup/creation/token-mint fails
     */
    public String verify(String rawEmail, String rawCode) throws FirebaseAuthException {
        String email = normalise(rawEmail);
        String code = rawCode == null ? "" : rawCode.trim();

        PendingCode current = pending.get(email);
        if (current == null) {
            throw new EmailCodeException(EmailCodeException.Reason.CODE_INVALID, "That code is not valid.");
        }
        if (clock.instant().isAfter(current.expiresAt())) {
            pending.remove(email);
            throw new EmailCodeException(
                    EmailCodeException.Reason.CODE_EXPIRED, "That code has expired. Please request a new one.");
        }
        if (!constantTimeEquals(current.codeHash(), hash(code))) {
            // Burn the code once the attempt budget is exhausted, so a short numeric code can't be
            // brute-forced; otherwise just consume one attempt and let the caller retry.
            if (current.attemptsLeft() <= 1) {
                pending.remove(email);
                throw new EmailCodeException(
                        EmailCodeException.Reason.VERIFY_RATE_LIMITED,
                        "Too many incorrect attempts. Please request a new code.");
            }
            pending.put(email, current.withOneFewerAttempt());
            throw new EmailCodeException(EmailCodeException.Reason.CODE_INVALID, "That code is not valid.");
        }

        // Correct: burn the single-use code BEFORE minting, so a token is never issued twice for it.
        pending.remove(email);
        lastSent.remove(email);

        String uid = resolveOrCreateUid(email);
        String token = firebaseAuth.getObject().createCustomToken(uid);
        log.info("Minted a custom token for an email-code login.");
        return token;
    }

    /** Look up the Firebase uid for {@code email}, creating the account on first sight. */
    private String resolveOrCreateUid(String email) throws FirebaseAuthException {
        FirebaseAuth auth = firebaseAuth.getObject();
        try {
            UserRecord existing = auth.getUserByEmail(email);
            return existing.getUid();
        } catch (FirebaseAuthException e) {
            if (e.getAuthErrorCode() == com.google.firebase.auth.AuthErrorCode.USER_NOT_FOUND) {
                UserRecord created = auth.createUser(new CreateRequest().setEmail(email).setEmailVerified(true));
                return created.getUid();
            }
            throw e;
        }
    }

    private String generateCode() {
        int bound = (int) Math.pow(10, props.length());
        int value = random.nextInt(bound);
        return String.format("%0" + props.length() + "d", value);
    }

    private static String normalise(String email) {
        return email == null ? "" : email.trim().toLowerCase(Locale.ROOT);
    }

    private static String hash(String code) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] out = digest.digest(code.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(out.length * 2);
            for (byte b : out) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            // SHA-256 is mandated by the JLS — unreachable on any conformant JVM.
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    /** Length-constant comparison of two equal-length hex hashes, so a verify can't be timed. */
    private static boolean constantTimeEquals(String a, String b) {
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    /** One outstanding code: the hash of the digits, when it expires, and how many tries remain. */
    private record PendingCode(String codeHash, Instant expiresAt, int attemptsLeft) {
        PendingCode withOneFewerAttempt() {
            return new PendingCode(codeHash, expiresAt, attemptsLeft - 1);
        }
    }
}
