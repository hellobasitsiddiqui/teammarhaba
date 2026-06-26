package com.teammarhaba.backend.device;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;

/**
 * {@link DeviceTokenService} behaviour exercised against a real Postgres (TM-283), focusing on the
 * seams the HTTP test doesn't reach directly: the {@link DeviceTokenService#prune(String) prune}
 * path used by the send-push service (TM-284), per-user lookup, and the token re-pointing to a new
 * owner on re-registration.
 */
class DeviceTokenServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private DeviceTokenService service;

    @Autowired
    private DeviceTokenRepository tokens;

    @Autowired
    private UserRepository users;

    @Autowired
    private AuditService audit;

    private static VerifiedUser user(String uid) {
        return new VerifiedUser(uid, uid + "@example.com");
    }

    @Test
    void registerProvisionsAccountAndPersistsTokenAgainstUserId() {
        service.register(user("svc-uid-1"), "tok-1", DevicePlatform.ANDROID);

        Long userId = users.findByFirebaseUid("svc-uid-1").orElseThrow().getId();
        assertThat(tokens.findByUserId(userId))
                .singleElement()
                .satisfies(t -> assertThat(t.getToken()).isEqualTo("tok-1"));
    }

    @Test
    void pruneRemovesTokenAndReportsWhetherAnythingWasRemoved() {
        service.register(user("svc-uid-prune"), "tok-prune", DevicePlatform.IOS);

        assertThat(service.prune("tok-prune")).isTrue(); // TM-284: FCM reported it unregistered
        assertThat(tokens.findByToken("tok-prune")).isEmpty();
        assertThat(service.prune("tok-prune")).isFalse(); // already gone — no-op
        assertThat(service.prune("never-seen")).isFalse();
    }

    @Test
    void deregisterRemovesOnlyTheCallersOwnToken() {
        // User B owns a token; user A (a different account) holds its value and tries to deregister it.
        service.register(user("svc-owner-b"), "b-token", DevicePlatform.ANDROID);
        Long ownerB = users.findByFirebaseUid("svc-owner-b").orElseThrow().getId();

        // A's deregister of B's token must be a no-op — no cross-account push silence (TM-291).
        service.deregister(user("svc-owner-a"), "b-token");
        assertThat(tokens.findByToken("b-token"))
                .as("user A must not be able to deregister user B's token")
                .isPresent()
                .get()
                .satisfies(t -> assertThat(t.getUserId()).isEqualTo(ownerB));

        // The rightful owner B can still deregister their own token.
        service.deregister(user("svc-owner-b"), "b-token");
        assertThat(tokens.findByToken("b-token")).isEmpty();
    }

    @Test
    void reregisteringATokenRepointsItToTheNewOwner() {
        service.register(user("svc-owner-a"), "shared-token", DevicePlatform.ANDROID);
        Long ownerA = users.findByFirebaseUid("svc-owner-a").orElseThrow().getId();
        assertThat(tokens.findByToken("shared-token").orElseThrow().getUserId()).isEqualTo(ownerA);

        // Same physical device, different account signs in: the token migrates, not duplicated.
        service.register(user("svc-owner-b"), "shared-token", DevicePlatform.ANDROID);
        Long ownerB = users.findByFirebaseUid("svc-owner-b").orElseThrow().getId();

        assertThat(tokens.findAll().stream().filter(t -> t.getToken().equals("shared-token")))
                .singleElement()
                .satisfies(t -> assertThat(t.getUserId()).isEqualTo(ownerB));
        assertThat(tokens.findByUserId(ownerA)).isEmpty();
    }

    @Test
    void auditTargetIsAFingerprintNotTheRawToken() {
        // TM-292: the raw FCM token is a sender-usable credential — it must never land in the audit
        // log. The DEVICE_TOKEN_REGISTERED event's target id is a short SHA-256 hex fingerprint.
        String rawToken = "fcm-secret-token-svc-audit";
        service.register(user("svc-uid-audit"), rawToken, DevicePlatform.ANDROID);

        var event = audit.search("svc-uid-audit", "DeviceToken", null, PageRequest.of(0, 10))
                .stream()
                .findFirst()
                .orElseThrow();

        assertThat(event.getTargetId())
                .isNotEqualTo(rawToken)
                .doesNotContain(rawToken)
                .hasSize(16)
                .matches("[0-9a-f]{16}");
    }
}
