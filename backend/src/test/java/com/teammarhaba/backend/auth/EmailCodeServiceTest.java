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
        return new EmailCodeProperties(
                6,
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

    // --- Inbox-free test-email hook (TM-312) ---

    @Test
    void allowListedDomainAddress_getsFixedCode_noSend_andVerifies() throws Exception {
        // Allow-list the @teammarhaba.test domain with a fixed code; real send must be skipped.
        EmailCodeProperties.TestEmail test =
                new EmailCodeProperties.TestEmail(List.of("@teammarhaba.test"), List.of(), "123456");
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
        String token = svc.verify(testEmail, "123456");
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
                new EmailCodeProperties.TestEmail(List.of("@teammarhaba.test"), List.of(), "123456");
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
                new EmailCodeProperties.TestEmail(List.of("@teammarhaba.test"), List.of(), "123456");
        EmailCodeService svc = new EmailCodeService(provider(), mailer, props(50, test), clock);

        svc.request(EMAIL); // ada@example.com — not allow-listed

        // A real (random) code was emailed, and it is NOT the fixed code.
        assertThat(mailer.sends).containsExactly(EMAIL);
        assertThat(mailer.lastCode).matches("\\d{6}").isNotEqualTo("123456");

        // The fixed code does NOT work for a real address; the emailed code does.
        assertThatThrownBy(() -> svc.verify(EMAIL, "123456"))
                .isInstanceOf(EmailCodeException.class);
    }

    @Test
    void lookalikeDomain_isNotAllowListed() {
        // "evil-teammarhaba.test" must NOT match the "@teammarhaba.test" suffix — real send path applies.
        EmailCodeProperties.TestEmail test =
                new EmailCodeProperties.TestEmail(List.of("@teammarhaba.test"), List.of(), "123456");
        EmailCodeService svc = new EmailCodeService(provider(), mailer, props(50, test), clock);

        svc.request("attacker@evil-teammarhaba.test");

        assertThat(mailer.sends).containsExactly("attacker@evil-teammarhaba.test");
        assertThat(mailer.lastCode).matches("\\d{6}").isNotEqualTo("123456");
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
