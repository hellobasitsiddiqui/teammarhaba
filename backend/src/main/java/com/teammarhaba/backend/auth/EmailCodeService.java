package com.teammarhaba.backend.auth;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.github.benmanes.caffeine.cache.Ticker;
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
 * enumerate accounts by timing; {@code verify} enforces the attempt cap. A coarse per-IP limit in
 * front of {@code request} lives in {@link EmailCodeRateLimiter} (varied addresses from one source
 * are still throttled). All three stores are process-local — fine for a single Cloud Run instance
 * and the common case; a distributed store (e.g. Redis) is the future improvement if the service
 * scales out and the limits must be global. (Same trade-off the TM-165 cooldown documents.)
 *
 * <p><strong>Bounded state (TM-247).</strong> {@code pending} and {@code lastSent} are
 * <em>bounded, expiring</em> Caffeine caches, not plain maps: each entry expires on its own
 * ({@code pending} after {@link EmailCodeProperties#ttl()} — a code is useless past then;
 * {@code lastSent} after {@link EmailCodeProperties#sendCooldown()} — the cooldown is over),
 * and each is capped at {@link EmailCodeProperties#maxOutstanding()} entries. So a flood of
 * distinct random addresses can neither pin entries for their full TTL nor grow the heap without
 * limit (the unbounded-map / mail-bomb DoS the TM-238 review flagged). A missing entry — expired or
 * size-evicted — reads exactly as "no outstanding code" / "no active cooldown", which is the safe,
 * already-handled case, so no behaviour changes for a legitimate user inside the window.
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

    /**
     * Normalised email -> the single outstanding code for that address. Bounded + expiring
     * (TM-247): entries expire after {@link EmailCodeProperties#ttl()} (a code is invalid past
     * then anyway) and the cache is size-capped, so a flood of distinct addresses can't grow it
     * without limit. A missing entry == "no outstanding code", the existing null-handled case.
     */
    private final Cache<String, PendingCode> pending;

    /**
     * Normalised email -> the instant of its last successful send; drives the send cooldown.
     * Bounded + expiring (TM-247): entries expire after {@link EmailCodeProperties#sendCooldown()}
     * (the cooldown is over by then, so the entry is meaningless) and the cache is size-capped. A
     * missing entry == "no active cooldown", the existing null-handled case.
     */
    private final Cache<String, Instant> lastSent;

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
        // Drive Caffeine's expiry off the same Clock as the cooldown/TTL logic so a test's
        // advanceable clock evicts entries deterministically (and prod uses real wall-clock time).
        Ticker ticker = () -> clock.instant().toEpochMilli() * 1_000_000L;
        // The logical TTL is enforced by PendingCode.expiresAt() in verify(); the cache is evicted a
        // little LATER (2x ttl) so a just-expired entry still exists to be read and reported as the
        // explicit CODE_EXPIRED (410), not silently dropped and misreported as CODE_INVALID (401).
        // After its logical expiry an entry can only ever yield CODE_EXPIRED, so keeping it briefly
        // longer leaks nothing new and still bounds memory (to ~2x the live-code window).
        this.pending = Caffeine.newBuilder()
                .ticker(ticker)
                .expireAfterWrite(props.ttl().multipliedBy(2))
                .maximumSize(props.maxOutstanding())
                .build();
        this.lastSent = Caffeine.newBuilder()
                .ticker(ticker)
                .expireAfterWrite(props.sendCooldown())
                .maximumSize(props.maxOutstanding())
                .build();
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

        // Inbox-free test-email hook (TM-312): an allow-listed address gets a FIXED, known code and the
        // real send is SKIPPED, so the email-code login can be driven end-to-end in CI without reading an
        // inbox. Off by default (empty allow-list => disabled), so prod is a no-op and real users are
        // unaffected. We bypass the send cooldown for the test path too, so the e2e harness can re-request
        // freely; the per-IP limiter (EmailCodeRateLimiter) still applies in front. (Marking these
        // accounts accountType=test is follow-up TM-311, not in scope here.)
        if (props.test().matches(email)) {
            String fixedCode = props.test().fixedCode();
            pending.put(email, new PendingCode(hash(fixedCode), now.plus(props.ttl()), props.maxVerifyAttempts()));
            log.info("Issued the FIXED test login code for an allow-listed test address (no email sent).");
            return;
        }

        Instant previous = lastSent.getIfPresent(email);
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
        String codeHash = hash(code);

        // Resolve the outcome under an ATOMIC read-modify-write on the pending entry (TM-732). The old
        // code did a getIfPresent -> decide -> put/invalidate, so two concurrent wrong guesses could both
        // read the same attemptsLeft, both decrement from it, and lose one decrement — letting an attacker
        // fan out parallel requests to get more than maxVerifyAttempts tries at a short numeric code.
        // Caffeine's asMap() is a ConcurrentMap; compute() runs the whole decision atomically per key, so
        // every wrong guess consumes exactly one attempt and the cap holds under concurrency. The lambda
        // is pure bookkeeping (no I/O) — the Firebase token mint stays OUTSIDE it.
        VerifyOutcome[] captured = {null};
        pending.asMap().compute(email, (key, current) -> {
            if (current == null) {
                captured[0] = VerifyOutcome.INVALID;
                return null; // absent -> stays absent
            }
            if (clock.instant().isAfter(current.expiresAt())) {
                captured[0] = VerifyOutcome.EXPIRED;
                return null; // burn the expired entry
            }
            if (!constantTimeEquals(current.codeHash(), codeHash)) {
                // Burn the code once the attempt budget is exhausted, so a short numeric code can't be
                // brute-forced; otherwise consume exactly one attempt and let the caller retry.
                if (current.attemptsLeft() <= 1) {
                    captured[0] = VerifyOutcome.RATE_LIMITED;
                    return null; // last attempt spent -> burn
                }
                captured[0] = VerifyOutcome.INVALID;
                return current.withOneFewerAttempt(); // atomic decrement
            }
            // Correct: burn the single-use code here (atomically), so a token is never issued twice for it.
            captured[0] = VerifyOutcome.CORRECT;
            return null;
        });

        switch (captured[0]) {
            case INVALID -> throw new EmailCodeException(
                    EmailCodeException.Reason.CODE_INVALID, "That code is not valid.");
            case EXPIRED -> throw new EmailCodeException(
                    EmailCodeException.Reason.CODE_EXPIRED, "That code has expired. Please request a new one.");
            case RATE_LIMITED -> throw new EmailCodeException(
                    EmailCodeException.Reason.VERIFY_RATE_LIMITED,
                    "Too many incorrect attempts. Please request a new code.");
            case CORRECT -> {
                // Fall through to the token mint below.
            }
        }

        lastSent.invalidate(email);
        String uid = resolveOrCreateUid(email);
        String token = firebaseAuth.getObject().createCustomToken(uid);
        log.info("Minted a custom token for an email-code login.");
        return token;
    }

    /** The mutually-exclusive results of one atomic {@code verify} attempt (TM-732). */
    private enum VerifyOutcome {
        INVALID,
        EXPIRED,
        RATE_LIMITED,
        CORRECT
    }

    /**
     * Test seam (TM-247): the number of addresses currently holding in-memory auth state across both
     * stores, after forcing any pending size-/time-based eviction. Lets a flood test assert the count
     * stays bounded (not N) under a flood of distinct addresses.
     */
    long trackedEntryCount() {
        pending.cleanUp();
        lastSent.cleanUp();
        return Math.max(pending.estimatedSize(), lastSent.estimatedSize());
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
