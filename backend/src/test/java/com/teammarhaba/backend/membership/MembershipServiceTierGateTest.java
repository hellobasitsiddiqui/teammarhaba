package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.config.MembershipProperties;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.ConflictException;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.access.AccessDeniedException;

/**
 * The TM-620 tier-switch payment gate: the old "no payment gate" shortcut in
 * {@link MembershipService#switchTier} is gone. Switching INTO a paid tier now requires a subscription
 * for exactly that tier that still entitles the caller; leaving a paid tier for the free base while the
 * subscription still renews is blocked in favour of cancel; and the subscription machinery's own
 * {@link MembershipService#applyTierForSubscription} path stays ungated (it IS the authority).
 */
class MembershipServiceTierGateTest {

    private static final VerifiedUser CALLER = new VerifiedUser("uid-42", "gate@example.com");

    private MembershipRepository memberships;
    private UserService users;
    private MembershipProvisioner provisioner;
    private AuditService audit;
    private SubscriptionRepository subscriptions;
    private MembershipService service;
    private Membership membership;

    @BeforeEach
    void setUp() {
        memberships = mock(MembershipRepository.class);
        users = mock(UserService.class);
        provisioner = mock(MembershipProvisioner.class);
        audit = mock(AuditService.class);
        subscriptions = mock(SubscriptionRepository.class);
        // Server-side membership flag ON for the ordinary gate tests; the flag-OFF 403 has its own test.
        service = new MembershipService(
                memberships, users, provisioner, audit, subscriptions, new MembershipProperties(true));

        User user = mock(User.class);
        when(user.getId()).thenReturn(42L);
        when(users.provision(any())).thenReturn(user);

        membership = new Membership(42L, Instant.now()); // JIT-enrolled default: PAY_PER_EVENT
        when(memberships.findByUserId(42L)).thenReturn(Optional.of(membership));
    }

    @Test
    void switchIntoPaidTierWithoutSubscriptionIsBlocked() {
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.switchTier(CALLER, MembershipTier.MONTHLY))
                .isInstanceOf(SubscriptionRequiredException.class);
        // Nothing changed, nothing audited — the free upgrade path is truly gone.
        assertThat(membership.getTier()).isEqualTo(MembershipTier.PAY_PER_EVENT);
        verify(audit, never()).record(anyString(), any(), anyString(), anyString(), any(Map.class));
    }

    @Test
    void switchIntoPaidTierWithActiveSubscriptionSucceeds() {
        Subscription active = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", Instant.now());
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(active));

        Membership result = service.switchTier(CALLER, MembershipTier.MONTHLY);

        assertThat(result.getTier()).isEqualTo(MembershipTier.MONTHLY);
        verify(audit)
                .record(
                        eq("uid-42"),
                        eq(AuditAction.MEMBERSHIP_TIER_CHANGED),
                        eq("Membership"),
                        eq("42"),
                        any(Map.class));
    }

    @Test
    void subscriptionTierMustMatchTheTargetTier() {
        // A MONTHLY subscription does not unlock DIAMOND.
        Subscription monthly = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", Instant.now());
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(monthly));

        assertThatThrownBy(() -> service.switchTier(CALLER, MembershipTier.DIAMOND))
                .isInstanceOf(SubscriptionRequiredException.class);
    }

    @Test
    void canceledSubscriptionStillEntitlesUntilPeriodEnd() {
        // Cancelled but the paid month has weeks left: switching (back) into the tier is still allowed.
        Subscription canceled = new Subscription(
                42L, MembershipTier.MONTHLY, "revolut", "cust-1", Instant.now().minus(Duration.ofDays(3)));
        canceled.cancelAtPeriodEnd(Instant.now());
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(canceled));

        Membership result = service.switchTier(CALLER, MembershipTier.MONTHLY);

        assertThat(result.getTier()).isEqualTo(MembershipTier.MONTHLY);
    }

    @Test
    void lapsedCanceledSubscriptionNoLongerEntitles() {
        // Cancelled AND past its period end — no paid time left, so the paid tier is gated again.
        Subscription lapsed = new Subscription(
                42L, MembershipTier.MONTHLY, "revolut", "cust-1", Instant.now().minus(Duration.ofDays(40)));
        lapsed.cancelAtPeriodEnd(Instant.now().minus(Duration.ofDays(9)));
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(lapsed));

        assertThatThrownBy(() -> service.switchTier(CALLER, MembershipTier.MONTHLY))
                .isInstanceOf(SubscriptionRequiredException.class);
    }

    @Test
    void leavingPaidTierWhileSubscriptionRenewsIsBlocked() {
        membership.changeTier(MembershipTier.MONTHLY, Instant.now());
        Subscription active = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", Instant.now());
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(active));

        // Dropping to the free base while still being billed would be a trap — point at cancel instead.
        assertThatThrownBy(() -> service.switchTier(CALLER, MembershipTier.PAY_PER_EVENT))
                .isInstanceOf(ConflictException.class);
        assertThat(membership.getTier()).isEqualTo(MembershipTier.MONTHLY);
    }

    @Test
    void leavingPaidTierAfterCancelIsAllowed() {
        membership.changeTier(MembershipTier.MONTHLY, Instant.now());
        Subscription canceled = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", Instant.now());
        canceled.cancelAtPeriodEnd(Instant.now());
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(canceled));

        Membership result = service.switchTier(CALLER, MembershipTier.PAY_PER_EVENT);

        assertThat(result.getTier()).isEqualTo(MembershipTier.PAY_PER_EVENT);
    }

    @Test
    void applyTierForSubscriptionBypassesTheGateAndAuditsWithMarker() {
        // The subscription machinery grants/downgrades tiers directly — no subscription row required
        // (this IS the path that runs when the subscription activates or lapses).
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.empty());

        Membership result = service.applyTierForSubscription(42L, MembershipTier.DIAMOND, "uid-42");

        assertThat(result.getTier()).isEqualTo(MembershipTier.DIAMOND);
        verify(audit)
                .record(
                        eq("uid-42"),
                        eq(AuditAction.MEMBERSHIP_TIER_CHANGED),
                        eq("Membership"),
                        eq("42"),
                        eq(Map.of("from", "PAY_PER_EVENT", "to", "DIAMOND", "via", "subscription")));
    }

    @Test
    void applyTierForSubscriptionIsIdempotent() {
        membership.changeTier(MembershipTier.MONTHLY, Instant.now());

        Membership result = service.applyTierForSubscription(42L, MembershipTier.MONTHLY, "uid-42");

        assertThat(result.getTier()).isEqualTo(MembershipTier.MONTHLY);
        verify(audit, never()).record(anyString(), any(), anyString(), anyString(), any(Map.class));
    }

    // ------------------------------------------------------------------ server-side flag (TM-623)

    @Test
    void switchIntoPaidTierIs403WhileTheServerSideMembershipFlagIsOff() {
        // Even a caller who somehow holds a matching ACTIVE subscription cannot switch into a paid
        // tier while the feature is off — the paid tiers do not exist server-side.
        MembershipService gated = new MembershipService(
                memberships, users, provisioner, audit, subscriptions, new MembershipProperties(false));
        Subscription active = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", Instant.now());
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(active));

        assertThatThrownBy(() -> gated.switchTier(CALLER, MembershipTier.MONTHLY))
                .isInstanceOf(AccessDeniedException.class);
        assertThat(membership.getTier()).isEqualTo(MembershipTier.PAY_PER_EVENT); // nothing changed
        verify(audit, never()).record(anyString(), any(), anyString(), anyString(), any(Map.class));
    }

    @Test
    void switchingDownToTheFreeBaseStaysAvailableWhileTheFlagIsOff() {
        // A feature rollback must never trap anyone in a paid tier: the DOWN switch is ungated. (The
        // renewing-subscription 409 doesn't apply here — no subscription row exists.)
        MembershipService gated = new MembershipService(
                memberships, users, provisioner, audit, subscriptions, new MembershipProperties(false));
        membership.changeTier(MembershipTier.MONTHLY, Instant.now());
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.empty());

        Membership result = gated.switchTier(CALLER, MembershipTier.PAY_PER_EVENT);

        assertThat(result.getTier()).isEqualTo(MembershipTier.PAY_PER_EVENT);
    }

    @Test
    void applyTierForSubscriptionStaysUngatedWhileTheFlagIsOff() {
        // The subscription machinery remains the authority even mid-rollback: a lapse/downgrade (or a
        // heal of money already taken) must still be able to apply the tier it decides.
        MembershipService gated = new MembershipService(
                memberships, users, provisioner, audit, subscriptions, new MembershipProperties(false));

        Membership result = gated.applyTierForSubscription(42L, MembershipTier.DIAMOND, "uid-42");

        assertThat(result.getTier()).isEqualTo(MembershipTier.DIAMOND);
    }
}
