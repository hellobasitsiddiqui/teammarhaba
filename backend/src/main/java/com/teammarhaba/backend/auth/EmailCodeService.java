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
import java.util.ArrayList;
import java.util.List;
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
 * outstanding code. Each address holds a <em>small set</em> of outstanding codes (up to
 * {@link #MAX_PENDING_CODES}, the most recent wins eviction) rather than a single slot: a resend, a
 * second device, or an impatient retry used to <em>overwrite</em> the outstanding code, and because
 * Gmail threads the identical-subject emails together, users routinely read the SUPERSEDED code and
 * were told it "is not valid" (TM-1003). Now every recent, unexpired code verifies. Codes are still
 * <em>single-use</em> — the first correct verify burns <strong>all</strong> codes for the address, so
 * a token is never minted twice and an old code can't be replayed after login — <em>short-lived</em>
 * ({@link EmailCodeProperties#ttl()}, each code honours its own expiry), and <em>attempt-capped</em>
 * ({@link EmailCodeProperties#maxVerifyAttempts()} wrong guesses <strong>shared across the whole
 * set</strong>, not per code, so holding 3 live codes never multiplies the brute-force budget).
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

    /**
     * How many outstanding codes one address may hold at once (TM-1003). 3 covers the real-world
     * shapes — "tap Resend once or twice", "started login on phone AND laptop" — without materially
     * widening the guessing surface (the verify attempt budget is shared across the set, so an
     * attacker still gets exactly {@link EmailCodeProperties#maxVerifyAttempts()} tries). When a 4th
     * code is requested the oldest is dropped, so memory per address stays O(1).
     */
    static final int MAX_PENDING_CODES = 3;

    private final ObjectProvider<FirebaseAuth> firebaseAuth;
    private final EmailCodeMailer mailer;
    private final EmailCodeProperties props;
    private final Clock clock;
    private final SecureRandom random = new SecureRandom();

    /**
     * Normalised email -> the outstanding codes for that address (up to {@link #MAX_PENDING_CODES},
     * TM-1003) plus their shared attempt budget. Bounded + expiring (TM-247): entries expire after
     * {@link EmailCodeProperties#ttl()} (every code in the entry is invalid past then anyway) and
     * the cache is size-capped, so a flood of distinct addresses can't grow it without limit. A
     * missing entry == "no outstanding code" — which now also covers the deploy/restart case (the
     * store is process-local, so a restart loses all pending codes) and is reported with an
     * actionable "expired or been replaced" message rather than a bare "not valid".
     */
    private final Cache<String, PendingCodes> pending;

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
     * Generate and email a fresh login code for {@code rawEmail}. The new code <em>joins</em> the
     * address's outstanding set (up to {@link #MAX_PENDING_CODES}, oldest evicted) rather than
     * replacing it (TM-1003) — so a "Resend", a second device, or an impatient retry never
     * invalidates the code the user is actually reading. Enforces the per-address send cooldown.
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
        // Deliberately still SINGLE-slot (a plain put, not an append): the fixed code is the only code
        // the harness ever submits, and replacing wholesale keeps the e2e state deterministic (TM-1003
        // multi-slot is for the real-mail path where a superseded code is the user-facing bug).
        if (props.test().matches(email)) {
            String fixedCode = props.test().fixedCode();
            pending.put(
                    email,
                    PendingCodes.single(
                            new PendingCode(hash(fixedCode), now.plus(props.ttl())), props.maxVerifyAttempts()));
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
        PendingCode fresh = new PendingCode(hash(code), now.plus(props.ttl()));
        // Atomic append (same asMap().compute() discipline as verify, TM-732): a fresh entry starts a
        // new set with the FULL attempt budget; an existing entry keeps its REMAINING budget — a resend
        // must not refill an attacker's guessing allowance (the budget only resets once the whole entry
        // is gone: burned, expired out, or never created).
        pending.asMap()
                .compute(email, (key, current) -> current == null
                        ? PendingCodes.single(fresh, props.maxVerifyAttempts())
                        : current.withNewCode(fresh, now, MAX_PENDING_CODES));
        lastSent.put(email, now);

        // Hand the plaintext to the mailer and let it go out of scope — only the hash is retained.
        mailer.sendLoginCode(email, code);
        log.info("Issued a login code for an address (cooldown started).");
    }

    /**
     * Verify {@code rawCode} against the address's outstanding codes and, on success, mint a Firebase
     * custom token for the address's account (creating the account on first sight, matching Firebase
     * passwordless). Any non-expired code in the set verifies (TM-1003 — the superseded-code fix);
     * codes stay single-use because the first correct match burns <strong>all</strong> of them.
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
                // No entry at all: never requested, all codes aged out of the cache, or the process
                // restarted (the store is in-memory, so a deploy wipes it). Distinct from a live wrong
                // guess so the user gets an actionable message instead of "not valid".
                captured[0] = VerifyOutcome.ABSENT;
                return null; // absent -> stays absent
            }
            Instant now = clock.instant();
            List<PendingCode> live = current.liveCodes(now);

            // 1) Correct match against ANY still-live code — including a superseded one (TM-1003).
            //    Burn the WHOLE set atomically: single-use is per address now, so a token can never be
            //    minted twice and no sibling code survives a successful login to be replayed.
            for (PendingCode candidate : live) {
                if (constantTimeEquals(candidate.codeHash(), codeHash)) {
                    captured[0] = VerifyOutcome.CORRECT;
                    return null;
                }
            }

            // 2) The submitted code IS one of ours but its own TTL has passed -> the explicit
            //    "expired" signal (410), not a bare "invalid" (401). Matching an expired code costs no
            //    attempt (parity with the old single-slot flow, where expiry was checked before the
            //    compare); the dead codes are pruned but any still-live siblings keep their chance.
            boolean matchesExpired = current.codes().stream()
                    .filter(c -> now.isAfter(c.expiresAt()))
                    .anyMatch(c -> constantTimeEquals(c.codeHash(), codeHash));
            if (matchesExpired) {
                captured[0] = VerifyOutcome.EXPIRED;
                return live.isEmpty() ? null : current.withCodes(live);
            }

            // 3) Nothing live left at all (every code aged past its TTL, submitted code matches none of
            //    the corpses): the whole entry is dead — report EXPIRED and drop it, exactly like the old
            //    single-slot behaviour for a touched expired entry.
            if (live.isEmpty()) {
                captured[0] = VerifyOutcome.EXPIRED;
                return null;
            }

            // 4) A genuinely wrong guess against live codes. The attempt budget is SHARED across the set
            //    (TM-1003): holding 3 live codes still allows only maxVerifyAttempts wrong guesses in
            //    total, so multi-slot never widens the brute-force surface. Burn everything once the
            //    budget is exhausted; otherwise consume exactly one attempt and let the caller retry.
            if (current.attemptsLeft() <= 1) {
                captured[0] = VerifyOutcome.RATE_LIMITED;
                return null; // last attempt spent -> burn ALL codes for the address
            }
            captured[0] = VerifyOutcome.INVALID;
            return current.withCodes(live).withOneFewerAttempt(); // atomic decrement (+ prune the dead)
        });

        switch (captured[0]) {
            case ABSENT -> throw new EmailCodeException(
                    EmailCodeException.Reason.CODE_INVALID,
                    "That code has expired or been replaced — request a new one.");
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

    /** The mutually-exclusive results of one atomic {@code verify} attempt (TM-732/TM-1003). */
    private enum VerifyOutcome {
        /** No pending entry for the address (never requested / aged out / process restarted). */
        ABSENT,
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
        // Full-entropy uniform pick in [0, 10^length). Use long maths: 10^length overflows an int at
        // length >= 10 (a supported length — @Min(4), no max), which would collapse the bound to a
        // negative/tiny value and gut the code's entropy. long holds up to 10^18 (length 18).
        long bound = (long) Math.pow(10, props.length());
        long value = random.nextLong(bound);
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

    /** One outstanding code: the hash of the digits and when it (individually) expires. */
    private record PendingCode(String codeHash, Instant expiresAt) {}

    /**
     * The full pending state for one address (TM-1003): its outstanding codes — oldest first, at most
     * {@link #MAX_PENDING_CODES} — and the attempt budget <strong>shared across all of them</strong>.
     * The budget deliberately lives on the set, not on each code: if every code carried its own
     * {@code maxVerifyAttempts}, requesting 3 codes would triple an attacker's guessing allowance.
     * Immutable (every mutation returns a new instance) so it composes safely with the atomic
     * {@code asMap().compute()} read-modify-write in {@code verify}/{@code request}.
     */
    private record PendingCodes(List<PendingCode> codes, int attemptsLeft) {
        /** A brand-new entry: one code, the full attempt budget. */
        static PendingCodes single(PendingCode code, int attempts) {
            return new PendingCodes(List.of(code), attempts);
        }

        /**
         * Append {@code fresh}, pruning codes already past their own TTL and evicting the oldest once
         * over {@code maxCodes}. Keeps the REMAINING attempt budget (a resend is not an attempt-budget
         * refill — see the comment at the call site in {@code request}).
         */
        PendingCodes withNewCode(PendingCode fresh, Instant now, int maxCodes) {
            List<PendingCode> next = new ArrayList<>(liveCodes(now));
            next.add(fresh);
            while (next.size() > maxCodes) {
                next.remove(0); // oldest first -> drop from the front
            }
            return new PendingCodes(List.copyOf(next), attemptsLeft);
        }

        /** The subset of codes whose own TTL has not yet passed, in original (oldest-first) order. */
        List<PendingCode> liveCodes(Instant now) {
            return codes.stream().filter(c -> !now.isAfter(c.expiresAt())).toList();
        }

        /** Same budget-keeping entry with a replaced (typically pruned) code list. */
        PendingCodes withCodes(List<PendingCode> replacement) {
            return new PendingCodes(List.copyOf(replacement), attemptsLeft);
        }

        PendingCodes withOneFewerAttempt() {
            return new PendingCodes(codes, attemptsLeft - 1);
        }
    }
}
