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
        return new EmailCodeProperties(
                6,
                Duration.ofMinutes(10),
                Duration.ofSeconds(60),
                5,
                maxOutstanding,
                20,
                Duration.ofMinutes(1),
                100_000);
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
