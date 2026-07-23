package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.google.firebase.auth.AuthErrorCode;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseAuthException;
import com.google.firebase.auth.UserRecord;
import com.google.firebase.auth.UserRecord.CreateRequest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Unit tests for {@link EmailCodeService} (TM-234): the happy path mints a custom token after a
 * correct code; a code is single-use, short-lived (expiry), send- and verify-rate-limited; and the
 * verify never reveals account existence. A capturing mailer lets a test learn the issued code so it
 * can verify with it — the production mailer never exposes the code.
 */
class EmailCodeServiceTest {

    private static final String EMAIL = "ada@example.com";
    private static final String UID = "uid-ada";
    private static final Instant T0 = Instant.parse("2026-01-01T00:00:00Z");

    private FirebaseAuth firebaseAuth;
    private CapturingMailer mailer;
    private MutableClock clock;
    private EmailCodeService service;

    @BeforeEach
    void setUp() throws Exception {
        firebaseAuth = mock(FirebaseAuth.class);

        @SuppressWarnings("unchecked")
        ObjectProvider<FirebaseAuth> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(firebaseAuth);

        // Default happy-path Firebase stubs: the user exists and a custom token is minted.
        UserRecord record = mock(UserRecord.class);
        when(record.getUid()).thenReturn(UID);
        when(firebaseAuth.getUserByEmail(EMAIL)).thenReturn(record);
        when(firebaseAuth.createCustomToken(UID)).thenReturn("custom-token-ada");

        mailer = new CapturingMailer();
        clock = new MutableClock(T0);
        // Short, explicit limits so the test reads clearly: 6 digits, 10m TTL, 60s cooldown, 5 tries.
        // A small maxOutstanding (50) makes the flood-bound assertion concrete; the per-IP limiter
        // tunables are exercised by EmailCodeRateLimiterTest, so any valid value will do here.
        service = new EmailCodeService(provider, mailer, props(50), clock);
    }

    /** Build properties with the given {@code maxOutstanding}; everything else fixed for the suite. */
    private static EmailCodeProperties props(long maxOutstanding) {
        return props(maxOutstanding, EmailCodeProperties.TestEmail.disabled());
    }

    /** As {@link #props(long)} but with an explicit test-email hook config (TM-312). */
    private static EmailCodeProperties props(long maxOutstanding, EmailCodeProperties.TestEmail test) {
        return propsOfLength(6, maxOutstanding, test);
    }

    /** Properties with an explicit code {@code length} — for the entropy/overflow test (TM-723). */
    private static EmailCodeProperties propsOfLength(int length, long maxOutstanding, EmailCodeProperties.TestEmail test) {
        return new EmailCodeProperties(
                length,
                Duration.ofMinutes(10),
                Duration.ofSeconds(60),
                5,
                maxOutstanding,
                20,
                Duration.ofMinutes(1),
                100_000,
                test);
    }

    @Test
    void happyPath_correctCodeMintsACustomToken() throws Exception {
        service.request(EMAIL);

        // The code was emailed (6 digits) and is treated as a credential by the real mailer.
        assertThat(mailer.lastCode).matches("\\d{6}");

        String token = service.verify(EMAIL, mailer.lastCode);

        assertThat(token).isEqualTo("custom-token-ada");
        verify(firebaseAuth).createCustomToken(UID);
    }

    @Test
    void codeIsSingleUse_secondVerifyWithSameCodeFails() throws Exception {
        service.request(EMAIL);
        String code = mailer.lastCode;

        service.verify(EMAIL, code); // burns it

        assertThatThrownBy(() -> service.verify(EMAIL, code))
                .isInstanceOf(EmailCodeException.class)
                .extracting(e -> ((EmailCodeException) e).reason())
                .isEqualTo(EmailCodeException.Reason.CODE_INVALID);
        verify(firebaseAuth, times(1)).createCustomToken(UID);
    }

    @Test
    void expiredCodeIsRejected() throws Exception {
        service.request(EMAIL);
        String code = mailer.lastCode;

        clock.advance(Duration.ofMinutes(10).plusSeconds(1)); // past the 10m TTL

        assertThatThrownBy(() -> service.verify(EMAIL, code))
                .isInstanceOf(EmailCodeException.class)
                .extracting(e -> ((EmailCodeException) e).reason())
                .isEqualTo(EmailCodeException.Reason.CODE_EXPIRED);
        verify(firebaseAuth, never()).createCustomToken(anyString());
    }

    @Test
    void sendIsRateLimited_secondRequestInsideCooldownIsRefused() {
        service.request(EMAIL);
        clock.advance(Duration.ofSeconds(30)); // inside the 60s cooldown

        assertThatThrownBy(() -> service.request(EMAIL))
                .isInstanceOf(EmailCodeException.class)
                .extracting(e -> ((EmailCodeException) e).reason())
                .isEqualTo(EmailCodeException.Reason.SEND_RATE_LIMITED);
        // Only the first send actually went out.
        assertThat(mailer.sends).hasSize(1);
    }

    @Test
    void sendIsAllowedAgainAfterTheCooldownElapses() {
        service.request(EMAIL);
        clock.advance(Duration.ofSeconds(61));
        service.request(EMAIL);

        assertThat(mailer.sends).hasSize(2);
    }

    @Test
    void verifyIsAttemptCapped_codeBurnsAfterTooManyWrongGuesses() throws Exception {
        service.request(EMAIL);
        String correct = mailer.lastCode;
        String wrong = nudge(correct);

        // 5 allowed attempts: the first 4 wrong guesses return CODE_INVALID...
        for (int i = 0; i < 4; i++) {
            assertThatThrownBy(() -> service.verify(EMAIL, wrong))
                    .isInstanceOf(EmailCodeException.class)
                    .extracting(e -> ((EmailCodeException) e).reason())
                    .isEqualTo(EmailCodeException.Reason.CODE_INVALID);
        }
        // ...the 5th burns the code with VERIFY_RATE_LIMITED...
        assertThatThrownBy(() -> service.verify(EMAIL, wrong))
                .isInstanceOf(EmailCodeException.class)
                .extracting(e -> ((EmailCodeException) e).reason())
                .isEqualTo(EmailCodeException.Reason.VERIFY_RATE_LIMITED);
        // ...and even the CORRECT code no longer works (it was burned).
        assertThatThrownBy(() -> service.verify(EMAIL, correct))
                .isInstanceOf(EmailCodeException.class)
                .extracting(e -> ((EmailCodeException) e).reason())
                .isEqualTo(EmailCodeException.Reason.CODE_INVALID);
        verify(firebaseAuth, never()).createCustomToken(anyString());
    }

    @Test
    void concurrentWrongGuessesCannotExceedTheAttemptCap() throws Exception {
        // TM-732 regression: the verify attempt counter was a non-atomic getIfPresent -> decide -> put.
        // Two concurrent wrong guesses could both read the same attemptsLeft and both decrement from it,
        // losing a decrement — so an attacker fanning out parallel requests got MORE than
        // maxVerifyAttempts (5) tries at a short numeric code. With the atomic asMap().compute() the cap
        // holds no matter how many threads race: at most (cap - 1) guesses ever see "wrong, budget left"
        // (CODE_INVALID); the one that spends the last attempt burns the code (VERIFY_RATE_LIMITED); and
        // every guess after that finds no outstanding code. The correct code must NOT work afterwards.
        service.request(EMAIL);
        String correct = mailer.lastCode;
        String wrong = nudge(correct);

        int threads = 64; // far more than the cap of 5 — maximise the race window
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(threads);
        java.util.concurrent.CountDownLatch ready = new java.util.concurrent.CountDownLatch(threads);
        java.util.concurrent.CountDownLatch go = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicInteger codeInvalid = new java.util.concurrent.atomic.AtomicInteger();
        java.util.concurrent.atomic.AtomicInteger rateLimited = new java.util.concurrent.atomic.AtomicInteger();

        List<java.util.concurrent.Future<?>> futures = new ArrayList<>();
        for (int i = 0; i < threads; i++) {
            futures.add(pool.submit(() -> {
                ready.countDown();
                try {
                    go.await();
                    service.verify(EMAIL, wrong); // all-wrong guesses, hammered simultaneously
                } catch (EmailCodeException e) {
                    if (e.reason() == EmailCodeException.Reason.CODE_INVALID) {
                        codeInvalid.incrementAndGet();
                    } else if (e.reason() == EmailCodeException.Reason.VERIFY_RATE_LIMITED) {
                        rateLimited.incrementAndGet();
                    }
                } catch (Exception ignored) {
                    // no other checked exception is expected on the wrong-code path
                }
            }));
        }
        ready.await();
        go.countDown(); // release all threads at once
        for (java.util.concurrent.Future<?> f : futures) {
            f.get();
        }
        pool.shutdown();

        // The budget is 5. A guess returns CODE_INVALID only while budget remained (attempts 1..4), so at
        // most 4 responses can be CODE_INVALID *with an outstanding code* — plus any that raced in after
        // the burn and found nothing (also CODE_INVALID). The decisive, race-proof invariant is that the
        // code is genuinely burned: the CORRECT code no longer works and no token was ever minted.
        assertThat(rateLimited.get())
                .as("exactly one guess spends the final attempt and burns the code")
                .isEqualTo(1);
        assertThatThrownBy(() -> service.verify(EMAIL, correct))
                .isInstanceOf(EmailCodeException.class)
                .extracting(e -> ((EmailCodeException) e).reason())
                .isEqualTo(EmailCodeException.Reason.CODE_INVALID);
        verify(firebaseAuth, never()).createCustomToken(anyString());
    }

    @Test
    void floodOfDistinctAddressesLeavesInMemoryStateBounded() {
        // The DoS the TM-238 review found: an attacker scripts `request` with millions of distinct,
        // validly-formed random addresses. With unbounded maps this grew the heap without limit; with
        // the bounded Caffeine caches the live entry count stays capped at maxOutstanding (50 here),
        // NOT the 5000 distinct addresses flooded.
        int flood = 5_000;
        for (int i = 0; i < flood; i++) {
            // Distinct address per call, and clock untouched so none expire — only the size cap bounds it.
            service.request("flood-" + i + "@example.com");
        }

        long tracked = service.trackedEntryCount();
        assertThat(tracked).isLessThan(flood); // the whole point: not N
        // Caffeine's maximumSize is approximate; allow generous slack but well below the flood size.
        assertThat(tracked).isLessThanOrEqualTo(50L * 3);
    }

    @Test
    void tenDigitCodeKeepsFullEntropy_noIntegerOverflow() {
        // TM-723: length 10 is supported (@Min(4), no max). The old `(int) Math.pow(10, 10)` overflowed
        // int to a negative bound, so `request` threw IllegalArgumentException from nextInt(negative) and
        // the whole 10-digit code path was broken. long maths fixes it. Generate many codes across
        // distinct addresses and assert: every code is exactly 10 digits, AND the full range is used —
        // leading digits vary (not stuck at 0), which a collapsed/overflowed bound could never produce.
        EmailCodeService svc =
                new EmailCodeService(provider(), mailer, propsOfLength(10, 100_000, EmailCodeProperties.TestEmail.disabled()), clock);

        java.util.Set<Character> leadingDigits = new java.util.HashSet<>();
        for (int i = 0; i < 200; i++) {
            svc.request("entropy-" + i + "@example.com");
            assertThat(mailer.lastCode).matches("\\d{10}");
            leadingDigits.add(mailer.lastCode.charAt(0));
        }
        // Uniform over [0, 10^10) => leading digit is ~uniform over 0-9; 200 draws makes all-but-a-few
        // near-certain. A collapsed bound would peg it to one value. Require broad spread, not exact 10.
        assertThat(leadingDigits).hasSizeGreaterThanOrEqualTo(8);
    }

    @Test
    void verifyWithNoOutstandingCodeFails() {
        assertThatThrownBy(() -> service.verify(EMAIL, "123456"))
                .isInstanceOf(EmailCodeException.class)
                .extracting(e -> ((EmailCodeException) e).reason())
                .isEqualTo(EmailCodeException.Reason.CODE_INVALID);
    }

    @Test
    void firstSightCreatesTheFirebaseAccount() throws Exception {
        // The user doesn't exist yet — getUserByEmail throws USER_NOT_FOUND, so we create it.
        FirebaseAuthException notFound = mock(FirebaseAuthException.class);
        when(notFound.getAuthErrorCode()).thenReturn(AuthErrorCode.USER_NOT_FOUND);
        when(firebaseAuth.getUserByEmail(EMAIL)).thenThrow(notFound);

        UserRecord created = mock(UserRecord.class);
        when(created.getUid()).thenReturn("uid-new");
        when(firebaseAuth.createUser(org.mockito.ArgumentMatchers.any(CreateRequest.class)))
                .thenReturn(created);
        when(firebaseAuth.createCustomToken("uid-new")).thenReturn("custom-token-new");

        service.request(EMAIL);
        String token = service.verify(EMAIL, mailer.lastCode);

        assertThat(token).isEqualTo("custom-token-new");
        verify(firebaseAuth).createUser(org.mockito.ArgumentMatchers.any(CreateRequest.class));
    }

    @Test
    void emailIsNormalised_caseAndWhitespaceInsensitive() throws Exception {
        service.request("  ADA@Example.com  ");
        // Verify with a differently-cased address for the same mailbox.
        String token = service.verify("ada@example.com", mailer.lastCode);
        assertThat(token).isEqualTo("custom-token-ada");
    }

    // --- Multi-slot pending codes (TM-1003) ---
    // A resend / second device / impatient retry used to OVERWRITE the single outstanding code, and
    // Gmail threads the identical-subject emails together — so users read the SUPERSEDED code and got
    // 401 "That code is not valid" for a code they were just sent. Each address now holds up to 3
    // recent codes, each honouring its own TTL, with ONE attempt budget shared across the set.

    @Test
    void supersededCode_stillVerifiesAfterAResend() throws Exception {
        // The core TM-1003 bug: request twice (A then B), then verify with A — the code the user is
        // actually reading. On the single-slot code this failed CODE_INVALID because B overwrote A.
        service.request(EMAIL);
        String codeA = mailer.lastCode;

        clock.advance(Duration.ofSeconds(61)); // past the send cooldown so the resend is allowed
        service.request(EMAIL);
        String codeB = mailer.lastCode;
        assertThat(mailer.sends).hasSize(2); // both emails really went out
        // (codeA == codeB is a 1-in-10^6 fluke; the assertion below is valid either way.)

        String token = service.verify(EMAIL, codeA);

        assertThat(token).isEqualTo("custom-token-ada");
        verify(firebaseAuth).createCustomToken(UID);
    }

    @Test
    void correctVerifyBurnsAllOutstandingCodes_siblingCodeCannotBeReplayed() throws Exception {
        // Single-use is per ADDRESS now: the first correct match burns the whole set, so the sibling
        // code B must not mint a second session after A logged the user in.
        service.request(EMAIL);
        String codeA = mailer.lastCode;
        clock.advance(Duration.ofSeconds(61));
        service.request(EMAIL);
        String codeB = mailer.lastCode;

        assertThat(service.verify(EMAIL, codeA)).isEqualTo("custom-token-ada"); // burns A AND B

        assertThatThrownBy(() -> service.verify(EMAIL, codeB))
                .isInstanceOf(EmailCodeException.class)
                .extracting(e -> ((EmailCodeException) e).reason())
                .isEqualTo(EmailCodeException.Reason.CODE_INVALID);
        verify(firebaseAuth, times(1)).createCustomToken(UID); // exactly one token ever minted
    }

    @Test
    void attemptCapIsSharedAcrossTheSet_notFivePerCode() throws Exception {
        // The budget (5) is SHARED across all outstanding codes AND survives a resend — a resend must
        // not refill an attacker's allowance. 3 wrong guesses, then a resend, then 2 more wrong
        // guesses = 5 across the set -> locked out. (On the old single-slot code the resend replaced
        // the entry with a FRESH budget of 5, so guess #5 was a plain CODE_INVALID — this test is the
        // shared-cap regression guard.)
        service.request(EMAIL);
        String codeA = mailer.lastCode;
        clock.advance(Duration.ofSeconds(61));
        service.request(EMAIL);
        String codeB = mailer.lastCode;
        String wrong = wrongCodeUnlike(codeA, codeB);

        // Wrong guesses 1..4 consume shared budget (two before an extra resend would even matter).
        for (int i = 0; i < 4; i++) {
            assertThatThrownBy(() -> service.verify(EMAIL, wrong))
                    .isInstanceOf(EmailCodeException.class)
                    .extracting(e -> ((EmailCodeException) e).reason())
                    .isEqualTo(EmailCodeException.Reason.CODE_INVALID);
        }
        // A mid-stream resend keeps the REMAINING budget (1), it does not reset to 5...
        clock.advance(Duration.ofSeconds(61));
        service.request(EMAIL);
        // ...so the 5th wrong guess across the set locks the address out and burns everything.
        assertThatThrownBy(() -> service.verify(EMAIL, wrong))
                .isInstanceOf(EmailCodeException.class)
                .extracting(e -> ((EmailCodeException) e).reason())
                .isEqualTo(EmailCodeException.Reason.VERIFY_RATE_LIMITED);

        // Both genuine codes were burned by the lockout — neither can mint a token any more.
        for (String burned : new String[] {codeA, codeB}) {
            assertThatThrownBy(() -> service.verify(EMAIL, burned))
                    .isInstanceOf(EmailCodeException.class)
                    .extracting(e -> ((EmailCodeException) e).reason())
                    .isEqualTo(EmailCodeException.Reason.CODE_INVALID);
        }
        verify(firebaseAuth, never()).createCustomToken(anyString());
    }

    @Test
    void absentEntry_reportsExpiredOrReplaced_coversRestartAndEviction() {
        // No pending entry (never requested / aged out / process restarted — the store is in-memory,
        // so every deploy wipes it). The message must tell the user the actionable truth ("request a
        // new one"), not the misleading "not valid". Still CODE_INVALID/401: an absent entry is not
        // the distinct just-expired-but-readable 410 case.
        assertThatThrownBy(() -> service.verify(EMAIL, "123456"))
                .isInstanceOf(EmailCodeException.class)
                .satisfies(e -> {
                    assertThat(((EmailCodeException) e).reason())
                            .isEqualTo(EmailCodeException.Reason.CODE_INVALID);
                    assertThat(e.getMessage())
                            .isEqualTo("That code has expired or been replaced — request a new one.");
                });
    }

    @Test
    void eachCodeHonoursItsOwnExpiry_oldCodeExpiresWhileNewerStaysValid() throws Exception {
        // Codes in the set expire INDIVIDUALLY: A (10m TTL) issued at T0 dies at T0+10m even though a
        // fresh B sits next to it. Submitting the dead A yields the explicit EXPIRED signal (-> 410,
        // "request a new one"), and crucially does NOT harm B, which still verifies.
        service.request(EMAIL);
        String codeA = mailer.lastCode;
        clock.advance(Duration.ofMinutes(9).plusSeconds(30)); // past cooldown, A still alive
        service.request(EMAIL);
        String codeB = mailer.lastCode;
        // Guard the 1-in-10^6 fluke where the two random codes collide — the EXPIRED-vs-live
        // distinction below is meaningless if A and B are literally the same digits.
        org.junit.jupiter.api.Assumptions.assumeTrue(!codeA.equals(codeB), "random codes collided");
        clock.advance(Duration.ofMinutes(1)); // now T0+10m30s: A expired, B has ~9m left

        assertThatThrownBy(() -> service.verify(EMAIL, codeA))
                .isInstanceOf(EmailCodeException.class)
                .extracting(e -> ((EmailCodeException) e).reason())
                .isEqualTo(EmailCodeException.Reason.CODE_EXPIRED);

        assertThat(service.verify(EMAIL, codeB)).isEqualTo("custom-token-ada");
    }

    // --- Inbox-free test-email hook (TM-312) ---

    @Test
    void allowListedDomainAddress_getsFixedCode_noSend_andVerifies() throws Exception {
        // Allow-list the @teammarhaba.test domain with an explicit non-default fixed code (TM-725: the
        // default 123456 is rejected for an enabled hook); real send must be skipped.
        EmailCodeProperties.TestEmail test =
                new EmailCodeProperties.TestEmail(List.of("@teammarhaba.test"), List.of(), "424242");
        EmailCodeService svc = new EmailCodeService(provider(), mailer, props(50, test), clock);

        String testEmail = "e2e@teammarhaba.test";
        UserRecord rec = recordWithUid("uid-test");
        when(firebaseAuth.getUserByEmail(testEmail)).thenReturn(rec);
        when(firebaseAuth.createCustomToken("uid-test")).thenReturn("token-test");

        svc.request(testEmail);

        // No email went out for the allow-listed address.
        assertThat(mailer.sends).isEmpty();
        assertThat(mailer.lastCode).isNull();

        // The fixed code verifies (and only the fixed code).
        String token = svc.verify(testEmail, "424242");
        assertThat(token).isEqualTo("token-test");
    }

    @Test
    void allowListedExplicitAddress_getsFixedCode_caseInsensitive() throws Exception {
        EmailCodeProperties.TestEmail test =
                new EmailCodeProperties.TestEmail(List.of(), List.of("ci-bot@teammarhaba.test"), "654321");
        EmailCodeService svc = new EmailCodeService(provider(), mailer, props(50, test), clock);

        String testEmail = "ci-bot@teammarhaba.test";
        UserRecord rec = recordWithUid("uid-ci");
        when(firebaseAuth.getUserByEmail(testEmail)).thenReturn(rec);
        when(firebaseAuth.createCustomToken("uid-ci")).thenReturn("token-ci");

        // Request with differing case + whitespace; the explicit allow-list matches after normalise.
        svc.request("  CI-Bot@TeamMarhaba.test ");
        assertThat(mailer.sends).isEmpty();

        assertThat(svc.verify(testEmail, "654321")).isEqualTo("token-ci");
    }

    @Test
    void allowListedAddress_wrongCodeStillRejected() {
        EmailCodeProperties.TestEmail test =
                new EmailCodeProperties.TestEmail(List.of("@teammarhaba.test"), List.of(), "424242");
        EmailCodeService svc = new EmailCodeService(provider(), mailer, props(50, test), clock);

        svc.request("e2e@teammarhaba.test");

        assertThatThrownBy(() -> svc.verify("e2e@teammarhaba.test", "000000"))
                .isInstanceOf(EmailCodeException.class)
                .extracting(e -> ((EmailCodeException) e).reason())
                .isEqualTo(EmailCodeException.Reason.CODE_INVALID);
    }

    @Test
    void nonAllowListedAddress_unaffectedByEnabledHook() throws Exception {
        // Hook ON for @teammarhaba.test, but a real address must keep random code + real send.
        EmailCodeProperties.TestEmail test =
                new EmailCodeProperties.TestEmail(List.of("@teammarhaba.test"), List.of(), "424242");
        EmailCodeService svc = new EmailCodeService(provider(), mailer, props(50, test), clock);

        svc.request(EMAIL); // ada@example.com — not allow-listed

        // A real (random) code was emailed, and it is NOT the fixed code.
        assertThat(mailer.sends).containsExactly(EMAIL);
        assertThat(mailer.lastCode).matches("\\d{6}").isNotEqualTo("424242");

        // The fixed code does NOT work for a real address; the emailed code does.
        assertThatThrownBy(() -> svc.verify(EMAIL, "424242"))
                .isInstanceOf(EmailCodeException.class);
    }

    @Test
    void lookalikeDomain_isNotAllowListed() {
        // "evil-teammarhaba.test" must NOT match the "@teammarhaba.test" suffix — real send path applies.
        EmailCodeProperties.TestEmail test =
                new EmailCodeProperties.TestEmail(List.of("@teammarhaba.test"), List.of(), "424242");
        EmailCodeService svc = new EmailCodeService(provider(), mailer, props(50, test), clock);

        svc.request("attacker@evil-teammarhaba.test");

        assertThat(mailer.sends).containsExactly("attacker@evil-teammarhaba.test");
        assertThat(mailer.lastCode).matches("\\d{6}").isNotEqualTo("424242");
    }

    @Test
    void emptyAllowList_isDisabled_soFixedCodeNeverWorks() {
        // Default disabled() => no address takes the test path, even one that "looks" like a test address.
        // The `service` built in setUp uses props(50), i.e. TestEmail.disabled().
        assertThat(EmailCodeProperties.TestEmail.disabled().isEnabled()).isFalse();

        service.request("anyone@teammarhaba.test");

        assertThat(mailer.sends).containsExactly("anyone@teammarhaba.test");
        assertThat(mailer.lastCode).matches("\\d{6}");
    }

    // --- Fail-closed test-login guard (TM-725) ---

    @Test
    void enabledHook_withDefaultCode_failsClosedAtConstruction() {
        // An enabled hook (non-empty allow-list) MUST NOT ship the well-known default 123456.
        assertThatThrownBy(
                        () -> new EmailCodeProperties.TestEmail(
                                List.of("@teammarhaba.test"), List.of(), "123456"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.auth.email-code.test");
    }

    @Test
    void enabledHook_withBlankCode_failsClosedAtConstruction() {
        // An enabled hook with a missing/blank code is rejected — no silent fallback to a default.
        assertThatThrownBy(
                        () -> new EmailCodeProperties.TestEmail(
                                List.of(), List.of("ci-bot@teammarhaba.test"), " "))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.auth.email-code.test");
    }

    @Test
    void enabledHook_withExplicitNonDefaultCode_isAccepted() {
        EmailCodeProperties.TestEmail test =
                new EmailCodeProperties.TestEmail(List.of("@teammarhaba.test"), List.of(), "424242");
        assertThat(test.isEnabled()).isTrue();
        assertThat(test.fixedCode()).isEqualTo("424242");
    }

    @Test
    void disabledHook_toleratesDefaultOrBlankCode() {
        // With an empty allow-list the code is inert, so the default/blank is harmless and never throws.
        assertThat(EmailCodeProperties.TestEmail.disabled().isEnabled()).isFalse();
        assertThat(new EmailCodeProperties.TestEmail(List.of(), List.of(), "123456").isEnabled()).isFalse();
        assertThat(new EmailCodeProperties.TestEmail(List.of(), List.of(), "").isEnabled()).isFalse();
    }

    /** A fresh provider mock returning the shared firebaseAuth — for tests that build their own service. */
    @SuppressWarnings("unchecked")
    private ObjectProvider<FirebaseAuth> provider() {
        ObjectProvider<FirebaseAuth> p = mock(ObjectProvider.class);
        when(p.getObject()).thenReturn(firebaseAuth);
        return p;
    }

    private static UserRecord recordWithUid(String uid) {
        UserRecord r = mock(UserRecord.class);
        when(r.getUid()).thenReturn(uid);
        return r;
    }

    /**
     * A 6-digit code guaranteed to differ from every given code: try the ten repeated-digit strings
     * ("000000".."999999") — at most {@code codes.length} of them can collide, so one always survives.
     */
    private static String wrongCodeUnlike(String... codes) {
        for (char d = '0'; d <= '9'; d++) {
            String candidate = String.valueOf(d).repeat(6);
            if (java.util.Arrays.stream(codes).noneMatch(candidate::equals)) {
                return candidate;
            }
        }
        throw new IllegalStateException("ten candidates cannot all collide with " + codes.length + " codes");
    }

    /** Flip one digit so the result is guaranteed different from {@code code}. */
    private static String nudge(String code) {
        char first = code.charAt(0);
        char replaced = first == '0' ? '1' : '0';
        return replaced + code.substring(1);
    }

    /** Test mailer that records every send and exposes the plaintext code (prod never does). */
    private static final class CapturingMailer implements EmailCodeMailer {
        private final List<String> sends = new ArrayList<>();
        private String lastCode;

        @Override
        public void sendLoginCode(String email, String code) {
            sends.add(email);
            lastCode = code;
        }
    }

    /** A test {@link Clock} whose instant can be advanced to drive TTL + cooldown deterministically. */
    private static final class MutableClock extends Clock {
        private Instant now;

        MutableClock(Instant start) {
            this.now = start;
        }

        void advance(Duration by) {
            now = now.plus(by);
        }

        @Override
        public Instant instant() {
            return now;
        }

        @Override
        public ZoneOffset getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }
    }
}
