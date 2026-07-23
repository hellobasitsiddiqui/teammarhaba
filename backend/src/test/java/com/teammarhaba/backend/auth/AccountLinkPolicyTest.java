package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.UserInfo;
import com.google.firebase.auth.UserRecord;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Unit tests for {@link AccountLinkPolicy} (TM-990) — the server-side proof-of-both gate for
 * multi-provider account convergence.
 *
 * <p>The security-critical contract under test: convergence is allowed ONLY when Firebase itself
 * attests the candidate identifier is verified on the SAME uid (proof of both). A bare string match,
 * an unverified identifier, or an unreadable identity provider must all REFUSE — never a silent
 * auto-merge (the account-takeover hole this ticket closes). Mirrors the Mockito + {@link
 * ObjectProvider} setup {@code EmailCodeServiceTest} uses.
 */
class AccountLinkPolicyTest {

    private static final String UID = "uid-primary";
    private static final String EMAIL = "ada@example.com";
    private static final String PHONE = "+447700900123";

    private FirebaseAuth firebaseAuth;
    private ObjectProvider<FirebaseAuth> provider;
    private AccountLinkPolicy policy;

    @BeforeEach
    void setUp() {
        firebaseAuth = mock(FirebaseAuth.class);
        @SuppressWarnings("unchecked")
        ObjectProvider<FirebaseAuth> p = mock(ObjectProvider.class);
        provider = p;
        when(provider.getIfAvailable()).thenReturn(firebaseAuth);
        policy = new AccountLinkPolicy(provider);
    }

    // ── email proof ──────────────────────────────────────────────────────────────────────────────

    @Test
    void emailLink_isProven_whenFirebaseHasItVerifiedOnThisUid() throws Exception {
        // (a) Two sign-ins for the same verified email converge: Firebase attests THIS uid owns THIS
        // email and has verified it → LINK (the safe convergence signal the email-code path uses).
        UserRecord record = mock(UserRecord.class);
        when(record.getEmail()).thenReturn(EMAIL);
        when(record.isEmailVerified()).thenReturn(true);
        when(firebaseAuth.getUser(UID)).thenReturn(record);

        assertThat(policy.decideEmailLink(UID, EMAIL)).isEqualTo(AccountLinkPolicy.LinkDecision.LINK);
        // Case/whitespace-insensitive — the same mailbox in different casing still converges.
        assertThat(policy.decideEmailLink(UID, "  ADA@Example.com "))
                .isEqualTo(AccountLinkPolicy.LinkDecision.LINK);
    }

    @Test
    void emailLink_isRefused_whenTheEmailIsNotVerifiedOnTheAccount() throws Exception {
        // (b) An UNVERIFIED match does NOT auto-link. The email is on the account but not verified —
        // that is not proof of control, so refuse rather than merge (the takeover guard).
        UserRecord record = mock(UserRecord.class);
        when(record.getEmail()).thenReturn(EMAIL);
        when(record.isEmailVerified()).thenReturn(false);
        when(record.getProviderData()).thenReturn(new UserInfo[0]);
        when(firebaseAuth.getUser(UID)).thenReturn(record);

        assertThat(policy.decideEmailLink(UID, EMAIL))
                .isEqualTo(AccountLinkPolicy.LinkDecision.REFUSE_UNVERIFIED);
    }

    @Test
    void emailLink_isRefused_whenTheAccountHoldsADifferentEmail() throws Exception {
        // A collision surfaces the refusal path, never a silent merge: the caller asks to bind an email
        // the account does NOT hold — refuse.
        UserRecord record = mock(UserRecord.class);
        when(record.getEmail()).thenReturn("someone-else@example.com");
        when(record.isEmailVerified()).thenReturn(true);
        when(record.getProviderData()).thenReturn(new UserInfo[0]);
        when(firebaseAuth.getUser(UID)).thenReturn(record);

        assertThat(policy.decideEmailLink(UID, EMAIL))
                .isEqualTo(AccountLinkPolicy.LinkDecision.REFUSE_UNVERIFIED);
    }

    @Test
    void emailLink_isProven_viaAVerifiedProviderEmail() throws Exception {
        // A provider entry (e.g. Google/password) carrying the same address is also proof Firebase holds
        // it against this uid — the primary email may differ but a provider proves control.
        UserRecord record = mock(UserRecord.class);
        when(record.getEmail()).thenReturn(null);
        when(record.isEmailVerified()).thenReturn(false);
        UserInfo google = mock(UserInfo.class);
        when(google.getProviderId()).thenReturn("google.com");
        when(google.getEmail()).thenReturn(EMAIL);
        when(record.getProviderData()).thenReturn(new UserInfo[] {google});
        when(firebaseAuth.getUser(UID)).thenReturn(record);

        assertThat(policy.decideEmailLink(UID, EMAIL)).isEqualTo(AccountLinkPolicy.LinkDecision.LINK);
    }

    // ── phone proof ──────────────────────────────────────────────────────────────────────────────

    @Test
    void phoneLink_isProven_whenFirebaseHasTheVerifiedNumberOnThisUid() throws Exception {
        // Firebase only ever stores a VERIFIED (OTP-linked) phone, so a matching primary number is proof
        // the caller controls it and it is bound to this uid → LINK.
        UserRecord record = mock(UserRecord.class);
        when(record.getPhoneNumber()).thenReturn(PHONE);
        when(record.getProviderData()).thenReturn(new UserInfo[0]);
        when(firebaseAuth.getUser(UID)).thenReturn(record);

        assertThat(policy.decidePhoneLink(UID, PHONE)).isEqualTo(AccountLinkPolicy.LinkDecision.LINK);
        // Digit-only comparison (matches the V48 DB uniqueness normalisation): separators don't matter.
        assertThat(policy.decidePhoneLink(UID, "+44 7700 900123"))
                .isEqualTo(AccountLinkPolicy.LinkDecision.LINK);
    }

    @Test
    void phoneLink_isProven_viaAPhoneProviderEntry() throws Exception {
        UserRecord record = mock(UserRecord.class);
        when(record.getPhoneNumber()).thenReturn(null);
        UserInfo phone = mock(UserInfo.class);
        when(phone.getProviderId()).thenReturn("phone");
        when(phone.getPhoneNumber()).thenReturn(PHONE);
        when(record.getProviderData()).thenReturn(new UserInfo[] {phone});
        when(firebaseAuth.getUser(UID)).thenReturn(record);

        assertThat(policy.decidePhoneLink(UID, PHONE)).isEqualTo(AccountLinkPolicy.LinkDecision.LINK);
    }

    @Test
    void phoneLink_isRefused_whenTheNumberIsNotOnTheAccount() throws Exception {
        // The candidate number is not verified on this uid — no proof of control, refuse (no auto-merge).
        UserRecord record = mock(UserRecord.class);
        when(record.getPhoneNumber()).thenReturn("+447700900999");
        when(record.getProviderData()).thenReturn(new UserInfo[0]);
        when(firebaseAuth.getUser(UID)).thenReturn(record);

        assertThat(policy.decidePhoneLink(UID, PHONE))
                .isEqualTo(AccountLinkPolicy.LinkDecision.REFUSE_UNVERIFIED);
    }

    // ── fail-closed ──────────────────────────────────────────────────────────────────────────────

    @Test
    void failsClosed_whenNoAdminSdkBeanIsAvailable() {
        // A security decision must refuse when it cannot read the truth: no Admin SDK bean
        // (dev/test/CI without ADC) is a refusal, not a silent pass.
        when(provider.getIfAvailable()).thenReturn(null);

        assertThat(policy.decideEmailLink(UID, EMAIL))
                .isEqualTo(AccountLinkPolicy.LinkDecision.REFUSE_UNVERIFIED);
        assertThat(policy.decidePhoneLink(UID, PHONE))
                .isEqualTo(AccountLinkPolicy.LinkDecision.REFUSE_UNVERIFIED);
    }

    @Test
    void failsClosed_whenTheFirebaseReadThrows() throws Exception {
        // An identity-provider error refuses the link, never waves it through.
        when(firebaseAuth.getUser(UID)).thenThrow(new RuntimeException("firebase down"));

        assertThat(policy.decideEmailLink(UID, EMAIL))
                .isEqualTo(AccountLinkPolicy.LinkDecision.REFUSE_UNVERIFIED);
        assertThat(policy.decidePhoneLink(UID, PHONE))
                .isEqualTo(AccountLinkPolicy.LinkDecision.REFUSE_UNVERIFIED);
    }

    @Test
    void blankCandidate_isRefused_withoutTouchingFirebase() {
        // A null/blank identifier is never proof of anything — refuse up front.
        assertThat(policy.decideEmailLink(UID, "  ")).isEqualTo(AccountLinkPolicy.LinkDecision.REFUSE_UNVERIFIED);
        assertThat(policy.decideEmailLink(UID, null)).isEqualTo(AccountLinkPolicy.LinkDecision.REFUSE_UNVERIFIED);
        assertThat(policy.decidePhoneLink(UID, "")).isEqualTo(AccountLinkPolicy.LinkDecision.REFUSE_UNVERIFIED);
        assertThat(policy.decidePhoneLink(UID, null)).isEqualTo(AccountLinkPolicy.LinkDecision.REFUSE_UNVERIFIED);
    }
}
