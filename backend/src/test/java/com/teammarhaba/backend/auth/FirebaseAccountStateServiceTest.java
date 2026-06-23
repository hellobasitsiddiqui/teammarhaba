package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseAuthException;
import com.google.firebase.auth.UserInfo;
import com.google.firebase.auth.UserMetadata;
import com.google.firebase.auth.UserRecord;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Unit tests for {@link FirebaseAccountStateService} (TM-164): the account-state block is read live
 * from the Admin SDK and mapped field-by-field, MFA is inferred from provider data (no typed
 * accessor in this SDK version), and every failure mode — no Admin SDK bean, user absent, SDK error
 * — degrades to {@link AccountState#unknown()} so {@code /me} never fails on Firebase.
 */
class FirebaseAccountStateServiceTest {

    private static final String UID = "uid-1";

    @SuppressWarnings("unchecked")
    private static ObjectProvider<FirebaseAuth> providerOf(FirebaseAuth auth) {
        ObjectProvider<FirebaseAuth> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(auth);
        return provider;
    }

    private static UserInfo providerData(String providerId) {
        UserInfo info = mock(UserInfo.class);
        when(info.getProviderId()).thenReturn(providerId);
        return info;
    }

    @Test
    void mapsFirebaseFieldsLive() throws Exception {
        UserMetadata metadata = mock(UserMetadata.class);
        when(metadata.getLastSignInTimestamp()).thenReturn(1_700_000_000_000L);

        UserInfo[] providers = {providerData("password")};
        UserRecord record = mock(UserRecord.class);
        when(record.isEmailVerified()).thenReturn(true);
        when(record.getPhoneNumber()).thenReturn("+44 20 7946 0958");
        when(record.getPhotoUrl()).thenReturn("https://example.com/p.png");
        when(record.getProviderData()).thenReturn(providers);
        when(record.getUserMetadata()).thenReturn(metadata);

        FirebaseAuth auth = mock(FirebaseAuth.class);
        when(auth.getUser(UID)).thenReturn(record);

        AccountState state = new FirebaseAccountStateService(providerOf(auth)).forUid(UID);

        assertThat(state.emailVerified()).isTrue();
        assertThat(state.phoneVerified()).isTrue(); // a phone number on file is a verified number
        assertThat(state.photoURL()).isEqualTo("https://example.com/p.png");
        assertThat(state.lastLoginAt()).isEqualTo(Instant.ofEpochMilli(1_700_000_000_000L));
        assertThat(state.mfaEnabled()).isFalse(); // only a primary password provider, no phone factor
    }

    @Test
    void reportsMfaWhenAPhoneSecondFactorSitsAlongsideANonPhonePrimary() throws Exception {
        UserInfo[] providers = {providerData("password"), providerData("phone")};
        UserRecord record = mock(UserRecord.class);
        when(record.getProviderData()).thenReturn(providers);

        FirebaseAuth auth = mock(FirebaseAuth.class);
        when(auth.getUser(UID)).thenReturn(record);

        assertThat(new FirebaseAccountStateService(providerOf(auth)).forUid(UID).mfaEnabled())
                .isTrue();
    }

    @Test
    void doesNotReportMfaForAPhoneOnlyAccount() throws Exception {
        UserInfo[] providers = {providerData("phone")};
        UserRecord record = mock(UserRecord.class);
        when(record.getProviderData()).thenReturn(providers);

        FirebaseAuth auth = mock(FirebaseAuth.class);
        when(auth.getUser(UID)).thenReturn(record);

        // A phone-only sign-in is not a second factor — no non-phone primary to pair with.
        assertThat(new FirebaseAccountStateService(providerOf(auth)).forUid(UID).mfaEnabled())
                .isFalse();
    }

    @Test
    void unsetLastSignInBecomesNull() throws Exception {
        UserMetadata metadata = mock(UserMetadata.class);
        when(metadata.getLastSignInTimestamp()).thenReturn(0L);

        UserRecord record = mock(UserRecord.class);
        when(record.getUserMetadata()).thenReturn(metadata);
        when(record.getProviderData()).thenReturn(null);

        FirebaseAuth auth = mock(FirebaseAuth.class);
        when(auth.getUser(UID)).thenReturn(record);

        assertThat(new FirebaseAccountStateService(providerOf(auth)).forUid(UID).lastLoginAt())
                .isNull();
    }

    @Test
    void degradesToUnknownWhenNoAdminSdkBeanIsAvailable() {
        AccountState state = new FirebaseAccountStateService(providerOf(null)).forUid(UID);
        assertThat(state).isEqualTo(AccountState.unknown());
    }

    @Test
    void degradesToUnknownWhenTheAdminSdkLookupFails() throws Exception {
        FirebaseAuth auth = mock(FirebaseAuth.class);
        when(auth.getUser(UID)).thenThrow(mock(FirebaseAuthException.class));

        AccountState state = new FirebaseAccountStateService(providerOf(auth)).forUid(UID);
        assertThat(state).isEqualTo(AccountState.unknown());
    }
}
