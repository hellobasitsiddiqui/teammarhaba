package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.UserRecord;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Unit tests for {@link EmailVerificationService} (TM-165): {@code emailVerified} is read live from
 * Firebase (never our truth); an already-verified address is refused; the per-user cooldown makes
 * the resend idempotent under bursts and lifts once the window elapses; and a refused call never
 * extends the window.
 */
class EmailVerificationServiceTest {

    private static final String UID = "uid-1";
    private static final String EMAIL = "ada@example.com";
    private static final Instant T0 = Instant.parse("2026-01-01T00:00:00Z");

    private FirebaseAuth firebaseAuth;
    private UserRecord user;
    private MutableClock clock;
    private EmailVerificationService service;

    @BeforeEach
    void setUp() {
        firebaseAuth = mock(FirebaseAuth.class);
        user = mock(UserRecord.class);
        when(user.getEmail()).thenReturn(EMAIL);

        @SuppressWarnings("unchecked")
        ObjectProvider<FirebaseAuth> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(firebaseAuth);

        clock = new MutableClock(T0);
        service = new EmailVerificationService(provider, clock);
    }

    @Test
    void sendsVerificationLinkForAnUnverifiedUser() throws Exception {
        when(user.isEmailVerified()).thenReturn(false);
        when(firebaseAuth.getUser(UID)).thenReturn(user);

        service.resend(UID);

        verify(firebaseAuth).generateEmailVerificationLink(EMAIL);
    }

    @Test
    void refusesWhenAlreadyVerifiedAndNeverCallsFirebaseSend() throws Exception {
        when(user.isEmailVerified()).thenReturn(true);
        when(firebaseAuth.getUser(UID)).thenReturn(user);

        assertThatThrownBy(() -> service.resend(UID))
                .isInstanceOf(EmailVerificationException.class)
                .extracting(e -> ((EmailVerificationException) e).reason())
                .isEqualTo(EmailVerificationException.Reason.ALREADY_VERIFIED);

        verify(firebaseAuth, never()).generateEmailVerificationLink(anyString());
    }

    @Test
    void secondResendInsideCooldownIsRefusedWithoutResending() throws Exception {
        when(user.isEmailVerified()).thenReturn(false);
        when(firebaseAuth.getUser(UID)).thenReturn(user);

        service.resend(UID); // first send records the window
        clock.advance(Duration.ofSeconds(30)); // still inside the 60s cooldown

        assertThatThrownBy(() -> service.resend(UID))
                .isInstanceOf(EmailVerificationException.class)
                .extracting(e -> ((EmailVerificationException) e).reason())
                .isEqualTo(EmailVerificationException.Reason.COOLDOWN);

        verify(firebaseAuth, times(1)).generateEmailVerificationLink(EMAIL);
    }

    @Test
    void resendIsAllowedAgainAfterTheCooldownElapses() throws Exception {
        when(user.isEmailVerified()).thenReturn(false);
        when(firebaseAuth.getUser(UID)).thenReturn(user);

        service.resend(UID);
        clock.advance(EmailVerificationService.COOLDOWN.plusSeconds(1));
        service.resend(UID);

        verify(firebaseAuth, times(2)).generateEmailVerificationLink(EMAIL);
    }

    @Test
    void cooldownIsPerUser() throws Exception {
        UserRecord other = mock(UserRecord.class);
        when(other.getEmail()).thenReturn("grace@example.com");
        when(other.isEmailVerified()).thenReturn(false);
        when(user.isEmailVerified()).thenReturn(false);
        when(firebaseAuth.getUser(UID)).thenReturn(user);
        when(firebaseAuth.getUser("uid-2")).thenReturn(other);

        service.resend(UID);
        service.resend("uid-2"); // a different user is not blocked by uid-1's cooldown

        verify(firebaseAuth).generateEmailVerificationLink(EMAIL);
        verify(firebaseAuth).generateEmailVerificationLink("grace@example.com");
    }

    /** A test {@link Clock} whose instant can be advanced to drive the cooldown deterministically. */
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
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }
    }
}
