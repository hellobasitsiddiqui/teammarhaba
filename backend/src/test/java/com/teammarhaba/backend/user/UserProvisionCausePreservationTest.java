package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedPhoneService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.config.PhoneVerificationProperties;
import com.teammarhaba.backend.interests.InterestCatalogueRepository;
import com.teammarhaba.backend.interests.InterestSelectionConfig;
import com.teammarhaba.backend.interests.UserInterestRepository;
import com.teammarhaba.backend.membership.SubscriptionRepository;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;

/**
 * TM-857 (nit 4): when provisioning's {@code DataIntegrityViolationException} is NOT the benign
 * unique-{@code firebase_uid} race — so the follow-up re-read still finds no row — the original DIVE
 * must be preserved as the cause of the {@link IllegalStateException}, not swallowed. Pinned here so
 * the diagnostic cause can never be dropped again.
 */
@ExtendWith(MockitoExtension.class)
class UserProvisionCausePreservationTest {

    @Mock private UserRepository users;
    @Mock private AuditService audit;
    @Mock private UserProvisioner provisioner;
    @Mock private SubscriptionRepository subscriptions;
    @Mock private UserInterestRepository userInterests;
    @Mock private InterestCatalogueRepository catalogue;
    @Mock private InterestSelectionConfig interestBounds;
    @Mock private VerifiedPhoneService verifiedPhoneService;

    private UserService userService() {
        return new UserService(
                users,
                audit,
                provisioner,
                subscriptions,
                userInterests,
                catalogue,
                interestBounds,
                new PhoneVerificationProperties(false),
                verifiedPhoneService);
    }

    @Test
    void aNonRaceIntegrityViolationIsChainedAsTheCauseNotSwallowed() {
        VerifiedUser caller = new VerifiedUser("uid-broken", "uid-broken@example.com");
        // No existing row, so provisioning is attempted; it fails with a DIVE that is NOT the uid race
        // (some other integrity violation), so the re-read below still finds nothing.
        when(users.findByFirebaseUid("uid-broken")).thenReturn(Optional.empty());
        DataIntegrityViolationException integrity =
                new DataIntegrityViolationException("check constraint violated (not the uid race)");
        when(provisioner.createOrReactivate(caller)).thenThrow(integrity);

        assertThatThrownBy(() -> userService().provision(caller))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("uid-broken")
                .cause()
                .isSameAs(integrity);
    }
}
