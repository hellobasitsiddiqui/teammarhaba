package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.GetUsersResult;
import com.google.firebase.auth.UserRecord;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.RoleService;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushNotificationService;
import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
import com.teammarhaba.backend.web.BadRequestException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import com.teammarhaba.backend.web.SelfActionNotAllowedException;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.test.util.ReflectionTestUtils;

/**
 * Rules of admin user-management (TM-111): 404 semantics, self-protection, claim-first role change,
 * audit (TM-137) — plus the best-effort auth-phone enrichment (TM-372): batched, degrades to empty
 * on any Firebase problem, never fails the console.
 */
class UserAdminServiceTest {

    private final UserRepository users = mock(UserRepository.class);
    private final RoleService roleService = mock(RoleService.class);
    private final AuditService audit = mock(AuditService.class);
    private final PushNotificationService push = mock(PushNotificationService.class);
    private final DeviceTokenRepository deviceTokens = mock(DeviceTokenRepository.class);

    @SuppressWarnings("unchecked")
    private final ObjectProvider<FirebaseAuth> firebaseAuthProvider = mock(ObjectProvider.class);

    private final UserAdminService service =
            new UserAdminService(users, roleService, audit, push, deviceTokens, firebaseAuthProvider);

    private static User account(String uid) {
        return new User(uid, uid + "@example.com", null);
    }

    /** An account with an explicit id + notification preference — for the push-eligibility tests (TM-427). */
    private static User account(String uid, long id, NotificationPref pref) {
        User u = account(uid);
        ReflectionTestUtils.setField(u, "id", id);
        u.setNotificationPref(pref);
        return u;
    }

    // --- push-eligibility signal for the admin send-notification page (TM-427) -------------------

    @Test
    void pushEligibilityCombinesPushPreferenceAndDevicePresence() {
        // Eligible == pref permits push (PUSH/BOTH) AND a device token exists — all four combinations:
        User pushWithDevice = account("push-dev", 1L, NotificationPref.BOTH);
        User pushNoDevice = account("push-nodev", 2L, NotificationPref.PUSH);
        User emailWithDevice = account("email-dev", 3L, NotificationPref.EMAIL); // has a device but opted out
        User emailNoDevice = account("email-nodev", 4L, NotificationPref.EMAIL);
        when(deviceTokens.findUserIdsWithTokens(any())).thenReturn(List.of(1L, 3L));

        Map<Long, Boolean> eligibility = service.pushEligibilityByUserId(
                List.of(pushWithDevice, pushNoDevice, emailWithDevice, emailNoDevice));

        assertThat(eligibility)
                .containsEntry(1L, true) // push pref + device
                .containsEntry(2L, false) // push pref, no device — a push would be lost
                .containsEntry(3L, false) // has a device but is opted out of push
                .containsEntry(4L, false); // neither
    }

    @Test
    void pushEligibilityOfAnEmptyPageIsEmptyAndSkipsTheQuery() {
        assertThat(service.pushEligibilityByUserId(List.of())).isEmpty();
        verifyNoInteractions(deviceTokens);
    }

    @Test
    void isPushEligibleTrueOnlyWithBothAPushPrefAndADevice() {
        User pushUser = account("solo", 7L, NotificationPref.BOTH);
        when(deviceTokens.existsByUserId(7L)).thenReturn(true);
        assertThat(service.isPushEligible(pushUser)).isTrue();

        when(deviceTokens.existsByUserId(7L)).thenReturn(false);
        assertThat(service.isPushEligible(pushUser)).isFalse(); // pref permits push, but no device to reach

        User emailUser = account("email-solo", 8L, NotificationPref.EMAIL);
        // Opted out of push — the device check is short-circuited (never queried), so no stub is needed.
        assertThat(service.isPushEligible(emailUser)).isFalse();
    }

    @Test
    void getMissingIdIs404() {
        when(users.findById(9L)).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.get(9L)).isInstanceOf(ResourceNotFoundException.class);
    }

    @Test
    void disableOfAnotherUserPersistsAndTouchesNoClaim() throws Exception {
        User target = account("target");
        when(users.findById(1L)).thenReturn(Optional.of(target));

        service.update(1L, false, null, "admin-uid");

        assertThat(target.isEnabled()).isFalse();
        verifyNoInteractions(roleService);
    }

    @Test
    void roleChangeWritesClaimThenMirrorsRow() throws Exception {
        User target = account("target"); // USER by default
        when(users.findById(1L)).thenReturn(Optional.of(target));

        service.update(1L, null, Role.ADMIN, "admin-uid");

        verify(roleService).assignRole("target", Role.ADMIN);
        assertThat(target.getRole()).isEqualTo(Role.ADMIN);
    }

    @Test
    void roleChangeToSameRoleIsANoOp() throws Exception {
        User target = account("target"); // already USER
        when(users.findById(1L)).thenReturn(Optional.of(target));

        service.update(1L, null, Role.USER, "admin-uid");

        verifyNoInteractions(roleService);
    }

    @Test
    void disableRecordsOneAuditEvent() throws Exception {
        User target = account("target"); // enabled by default
        when(users.findById(1L)).thenReturn(Optional.of(target));

        service.update(1L, false, null, "admin-uid");

        verify(audit)
                .record("admin-uid", AuditAction.ACCOUNT_ENABLED_CHANGED, "User", "1", Map.of("enabled", false));
    }

    @Test
    void roleChangeRecordsOneAuditEvent() throws Exception {
        User target = account("target"); // USER by default
        when(users.findById(1L)).thenReturn(Optional.of(target));

        service.update(1L, null, Role.ADMIN, "admin-uid");

        verify(audit)
                .record("admin-uid", AuditAction.ROLE_CHANGED, "User", "1", Map.of("from", "USER", "to", "ADMIN"));
    }

    @Test
    void aNoOpUpdateRecordsNoAuditEvent() throws Exception {
        User target = account("target"); // already enabled + USER
        when(users.findById(1L)).thenReturn(Optional.of(target));

        service.update(1L, true, Role.USER, "admin-uid"); // both are no-ops

        verifyNoInteractions(audit);
    }

    @Test
    void cannotDisableOwnAccount() {
        User self = account("self");
        when(users.findById(1L)).thenReturn(Optional.of(self));

        assertThatThrownBy(() -> service.update(1L, false, null, "self"))
                .isInstanceOf(SelfActionNotAllowedException.class);
        assertThat(self.isEnabled()).isTrue();
        verifyNoInteractions(roleService);
    }

    @Test
    void cannotChangeOwnRole() {
        User self = account("self"); // USER
        when(users.findById(1L)).thenReturn(Optional.of(self));

        assertThatThrownBy(() -> service.update(1L, null, Role.ADMIN, "self"))
                .isInstanceOf(SelfActionNotAllowedException.class);
        assertThat(self.getRole()).isEqualTo(Role.USER);
        verifyNoInteractions(roleService);
    }

    @Test
    void canReEnableYourOwnAccount() throws Exception {
        // Self-protection blocks disabling/demoting yourself, not enabling — that can't lock you out.
        User self = account("self");
        when(users.findById(1L)).thenReturn(Optional.of(self));

        service.update(1L, true, null, "self");

        assertThat(self.isEnabled()).isTrue();
    }

    @Test
    void reEnablingAnAccountPushesToTheUsersDevices() throws Exception {
        User target = account("target");
        target.setEnabled(false); // start disabled so true is an effective re-enable
        when(users.findById(1L)).thenReturn(Optional.of(target));

        service.update(1L, true, null, "admin-uid");

        // The real send-push trigger (TM-284): re-enable fans a push out to the account's devices, and
        // (TM-290) deep-links the tap to the user's profile.
        org.mockito.ArgumentCaptor<PushMessage> msg = org.mockito.ArgumentCaptor.forClass(PushMessage.class);
        verify(push).sendToUser(org.mockito.ArgumentMatchers.eq(target.getId()), msg.capture());
        assertThat(msg.getValue().route()).isEqualTo("#/profile");
    }

    @Test
    void disablingAnAccountDoesNotPush() throws Exception {
        User target = account("target"); // enabled by default
        when(users.findById(1L)).thenReturn(Optional.of(target));

        service.update(1L, false, null, "admin-uid");

        verifyNoInteractions(push);
    }

    @Test
    void aPushFailureDoesNotFailTheReEnable() throws Exception {
        User target = account("target");
        target.setEnabled(false);
        when(users.findById(1L)).thenReturn(Optional.of(target));
        org.mockito.Mockito.doThrow(new RuntimeException("fcm down"))
                .when(push)
                .sendToUser(any(), any(PushMessage.class));

        service.update(1L, true, null, "admin-uid"); // must not throw

        assertThat(target.isEnabled()).isTrue();
    }

    @Test
    void testPushSetsTheRequestedKnownRouteOnTheMessage() {
        User target = account("target");
        when(users.findById(1L)).thenReturn(Optional.of(target));
        when(push.sendToUser(org.mockito.ArgumentMatchers.any(), any(PushMessage.class)))
                .thenReturn(new PushFanout(1, 1, 0, 0));

        // TM-290: a known route flows through to the message's data.route.
        service.sendTestPush(1L, "#/admin");

        org.mockito.ArgumentCaptor<PushMessage> msg = org.mockito.ArgumentCaptor.forClass(PushMessage.class);
        verify(push).sendToUser(org.mockito.ArgumentMatchers.eq(target.getId()), msg.capture());
        assertThat(msg.getValue().route()).isEqualTo("#/admin");
    }

    @Test
    void testPushWithNoRouteSendsAPlainNotification() {
        User target = account("target");
        when(users.findById(1L)).thenReturn(Optional.of(target));
        when(push.sendToUser(org.mockito.ArgumentMatchers.any(), any(PushMessage.class)))
                .thenReturn(new PushFanout(0, 0, 0, 0));

        service.sendTestPush(1L, null);

        org.mockito.ArgumentCaptor<PushMessage> msg = org.mockito.ArgumentCaptor.forClass(PushMessage.class);
        verify(push).sendToUser(org.mockito.ArgumentMatchers.eq(target.getId()), msg.capture());
        assertThat(msg.getValue().route()).isNull();
    }

    @Test
    void testPushRejectsAnUnknownRouteWithoutSending() {
        // TM-290: an off-allow-list route is a 400 and never reaches the send path (no off-list route
        // emitted). The user lookup needn't even happen — the route is rejected first.
        assertThatThrownBy(() -> service.sendTestPush(1L, "#/evil"))
                .isInstanceOf(BadRequestException.class);

        verifyNoInteractions(push);
    }

    @Test
    void listDelegatesToRepository() {
        Pageable pageable = PageRequest.of(0, 20);
        Page<User> page = new PageImpl<>(List.of(account("a")));
        when(users.findAll(pageable)).thenReturn(page);

        assertThat(service.list(pageable)).isSameAs(page);
    }

    // --- auth-phone enrichment (TM-372): identify phone-auth accounts with no email/name ---

    /** A mocked Firebase account record with the given uid and (possibly null) phone number. */
    private static UserRecord firebaseRecord(String uid, String phone) {
        UserRecord record = mock(UserRecord.class);
        when(record.getUid()).thenReturn(uid);
        when(record.getPhoneNumber()).thenReturn(phone);
        return record;
    }

    @Test
    void authPhonesComeFromOneBatchedFirebaseLookup() throws Exception {
        FirebaseAuth auth = mock(FirebaseAuth.class);
        when(firebaseAuthProvider.getIfAvailable()).thenReturn(auth);
        // One account with a phone identity, one (email sign-in) without — only the former maps.
        // Built BEFORE the result stubbing: nesting when() inside thenReturn() trips Mockito.
        Set<UserRecord> records =
                Set.of(firebaseRecord("phone-uid", "+16505550100"), firebaseRecord("email-uid", null));
        GetUsersResult result = mock(GetUsersResult.class);
        when(result.getUsers()).thenReturn(records);
        when(auth.getUsers(any())).thenReturn(result);

        Map<String, String> phones = service.authPhonesByUid(List.of("phone-uid", "email-uid"));

        assertThat(phones).containsExactlyEntriesOf(Map.of("phone-uid", "+16505550100"));
        verify(auth, times(1)).getUsers(any()); // one batched round trip, not one call per account
    }

    @Test
    void authPhonesAreEmptyWithoutTheAdminSdk() {
        // No FirebaseAuth bean (dev/test/CI without credentials): degrade to empty, never throw.
        when(firebaseAuthProvider.getIfAvailable()).thenReturn(null);

        assertThat(service.authPhonesByUid(List.of("some-uid"))).isEmpty();
    }

    @Test
    void authPhonesDegradeToEmptyOnAnSdkFailure() throws Exception {
        // An identity-provider blip must degrade the phone column, not 500 the admin user list.
        FirebaseAuth auth = mock(FirebaseAuth.class);
        when(firebaseAuthProvider.getIfAvailable()).thenReturn(auth);
        when(auth.getUsers(any())).thenThrow(new IllegalStateException("firebase down"));

        assertThat(service.authPhonesByUid(List.of("some-uid"))).isEmpty();
    }

    @Test
    void authPhonesTolerateANullSdkResult() throws Exception {
        // Defensive: an unstubbed FirebaseAuth test double returns null — treat as "nothing found".
        FirebaseAuth auth = mock(FirebaseAuth.class);
        when(firebaseAuthProvider.getIfAvailable()).thenReturn(auth);
        when(auth.getUsers(any())).thenReturn(null);

        assertThat(service.authPhonesByUid(List.of("some-uid"))).isEmpty();
    }

    @Test
    void noUidsMeansNoFirebaseCall() {
        assertThat(service.authPhonesByUid(List.of())).isEmpty();
        assertThat(service.authPhonesByUid(null)).isEmpty();

        verifyNoInteractions(firebaseAuthProvider);
    }

    @Test
    void authPhoneForASingleUidReadsTheBatchAndNullMeansUnknown() throws Exception {
        FirebaseAuth auth = mock(FirebaseAuth.class);
        when(firebaseAuthProvider.getIfAvailable()).thenReturn(auth);
        Set<UserRecord> records = Set.of(firebaseRecord("phone-uid", "+16505550100"));
        GetUsersResult result = mock(GetUsersResult.class);
        when(result.getUsers()).thenReturn(records);
        when(auth.getUsers(any())).thenReturn(result);

        assertThat(service.authPhoneFor("phone-uid")).isEqualTo("+16505550100");
        assertThat(service.authPhoneFor(null)).isNull();
    }
}
