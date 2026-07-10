package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.payments.PaymentOrder;
import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.BadRequestException;
import com.teammarhaba.backend.web.ConflictException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * Unit coverage of the subscription lifecycle (TM-620) with NO live payment calls: the Subscribe
 * checkout (customer + provider order + PENDING INITIAL charge + widget token), the webhook-driven
 * activation (charge PAID → ACTIVE subscription + tier grant + saved-card resolution), cancel
 * (stop renewals, keep the tier to the period end) and the idempotency guarantees of each. The
 * {@link PaymentProvider} seam is mocked — the CI bar; the sandbox handshake is the post-deploy
 * live smoke test.
 */
class SubscriptionServiceTest {

    private static final VerifiedUser CALLER = new VerifiedUser("uid-42", "sub@example.com");

    private SubscriptionRepository subscriptions;
    private SubscriptionChargeRepository charges;
    private MembershipService memberships;
    private UserService users;
    private PaymentProvider payments;
    private AuditService audit;
    private SubscriptionNotifier notifier;
    private SubscriptionService service;
    private User user;

    @BeforeEach
    void setUp() {
        subscriptions = mock(SubscriptionRepository.class);
        charges = mock(SubscriptionChargeRepository.class);
        memberships = mock(MembershipService.class);
        users = mock(UserService.class);
        payments = mock(PaymentProvider.class);
        audit = mock(AuditService.class);
        notifier = mock(SubscriptionNotifier.class);
        service = new SubscriptionService(subscriptions, charges, memberships, users, payments, audit, notifier);

        user = mock(User.class);
        when(user.getId()).thenReturn(42L);
        when(user.getEmail()).thenReturn("sub@example.com");
        when(user.getDisplayName()).thenReturn("Sub Scriber");
        when(user.getFirebaseUid()).thenReturn("uid-42");
        when(users.provision(any())).thenReturn(user);
        when(users.getById(42L)).thenReturn(user);
        when(payments.name()).thenReturn("revolut");

        // Repository saves echo the entity back (the DB would assign ids; the logic under test doesn't need them).
        when(charges.save(any(SubscriptionCharge.class))).thenAnswer(inv -> inv.getArgument(0));
        when(subscriptions.save(any(Subscription.class))).thenAnswer(inv -> inv.getArgument(0));
    }

    // ------------------------------------------------------------------ subscribe checkout

    @Test
    void checkoutCreatesCustomerOrderAndPendingInitialCharge() {
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.empty());
        when(charges.findFirstByUserIdAndKindAndStatus(
                        42L, SubscriptionCharge.Kind.INITIAL, SubscriptionCharge.Status.PENDING))
                .thenReturn(Optional.empty());
        when(payments.createCustomer("sub@example.com", "Sub Scriber")).thenReturn("cust-1");
        when(payments.createOrderForCustomer(eq(999), eq("GBP"), anyString(), eq("cust-1")))
                .thenReturn(new PaymentOrder("rev-ord-1", "tok-1"));

        SubscriptionCheckout result = service.checkout(CALLER, MembershipTier.MONTHLY);

        // The browser gets the tier, the LOCKED server-side price, the single-use token and the provider.
        assertThat(result.tier()).isEqualTo(MembershipTier.MONTHLY);
        assertThat(result.amountPence()).isEqualTo(999);
        assertThat(result.paymentToken()).isEqualTo("tok-1");
        assertThat(result.provider()).isEqualTo("revolut");

        // A PENDING INITIAL charge carrying the provider order + customer (the webhook activation keys).
        ArgumentCaptor<SubscriptionCharge> saved = ArgumentCaptor.forClass(SubscriptionCharge.class);
        verify(charges).save(saved.capture());
        SubscriptionCharge charge = saved.getValue();
        assertThat(charge.getKind()).isEqualTo(SubscriptionCharge.Kind.INITIAL);
        assertThat(charge.getStatus()).isEqualTo(SubscriptionCharge.Status.PENDING);
        assertThat(charge.getAmountPence()).isEqualTo(999);
        assertThat(charge.getProviderOrderId()).isEqualTo("rev-ord-1");
        assertThat(charge.getProviderCustomerId()).isEqualTo("cust-1");

        // The checkout serialises on the caller's user-row lock (TM-423 convention).
        verify(users).lockForUpdate(42L);
    }

    @Test
    void checkoutPricesDiamondAt1999() {
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.empty());
        when(charges.findFirstByUserIdAndKindAndStatus(any(), any(), any())).thenReturn(Optional.empty());
        when(payments.createCustomer(anyString(), anyString())).thenReturn("cust-1");
        when(payments.createOrderForCustomer(eq(1999), eq("GBP"), anyString(), eq("cust-1")))
                .thenReturn(new PaymentOrder("rev-ord-2", "tok-2"));

        SubscriptionCheckout result = service.checkout(CALLER, MembershipTier.DIAMOND);

        assertThat(result.amountPence()).isEqualTo(1999);
    }

    @Test
    void checkoutRejectsFreeBaseTier() {
        assertThatThrownBy(() -> service.checkout(CALLER, MembershipTier.PAY_PER_EVENT))
                .isInstanceOf(BadRequestException.class);
        verify(payments, never()).createCustomer(anyString(), anyString());
    }

    @Test
    void checkoutConflictsWhenAlreadyActivelySubscribed() {
        Subscription active = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", Instant.now());
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(active));

        assertThatThrownBy(() -> service.checkout(CALLER, MembershipTier.DIAMOND))
                .isInstanceOf(ConflictException.class);
        verify(payments, never()).createOrderForCustomer(anyInt(), anyString(), anyString(), anyString());
    }

    @Test
    void checkoutAfterCancelReusesProviderCustomerAndAllowsResubscribe() {
        // A CANCELED subscription does not block re-subscribing, and its provider customer is reused.
        Subscription canceled = new Subscription(
                42L, MembershipTier.MONTHLY, "revolut", "cust-1", Instant.now().minus(Duration.ofDays(40)));
        canceled.cancelAtPeriodEnd(Instant.now().minus(Duration.ofDays(20)));
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(canceled));
        when(charges.findFirstByUserIdAndKindAndStatus(any(), any(), any())).thenReturn(Optional.empty());
        when(payments.createOrderForCustomer(eq(999), eq("GBP"), anyString(), eq("cust-1")))
                .thenReturn(new PaymentOrder("rev-ord-3", "tok-3"));

        SubscriptionCheckout result = service.checkout(CALLER, MembershipTier.MONTHLY);

        assertThat(result.paymentToken()).isEqualTo("tok-3");
        verify(payments, never()).createCustomer(anyString(), anyString()); // reused, not re-registered
    }

    @Test
    void checkoutReusesAbandonedPendingInitialCharge() {
        // A previous attempt left a PENDING INITIAL charge — it is re-pointed, not duplicated.
        Instant earlier = Instant.now().minus(Duration.ofHours(1));
        SubscriptionCharge abandoned =
                new SubscriptionCharge(42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, earlier);
        abandoned.setPaymentReference("revolut", "rev-old", "cust-1", earlier);
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.empty());
        when(charges.findFirstByUserIdAndKindAndStatus(
                        42L, SubscriptionCharge.Kind.INITIAL, SubscriptionCharge.Status.PENDING))
                .thenReturn(Optional.of(abandoned));
        when(payments.createCustomer(anyString(), anyString())).thenReturn("cust-1");
        when(payments.createOrderForCustomer(eq(1999), eq("GBP"), anyString(), eq("cust-1")))
                .thenReturn(new PaymentOrder("rev-new", "tok-new"));

        SubscriptionCheckout result = service.checkout(CALLER, MembershipTier.DIAMOND);

        // No second row saved; the abandoned one now carries the fresh order + the newly chosen tier.
        verify(charges, never()).save(any(SubscriptionCharge.class));
        assertThat(result.paymentToken()).isEqualTo("tok-new");
        assertThat(abandoned.getTier()).isEqualTo(MembershipTier.DIAMOND);
        assertThat(abandoned.getAmountPence()).isEqualTo(1999);
        assertThat(abandoned.getProviderOrderId()).isEqualTo("rev-new");
    }

    // ------------------------------------------------------------------ webhook activation

    @Test
    void confirmChargeActivatesSubscriptionGrantsTierAndSavesCard() {
        Instant chargeTime = Instant.now();
        SubscriptionCharge charge =
                new SubscriptionCharge(42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, chargeTime);
        charge.setPaymentReference("revolut", "rev-ord-1", "cust-1", chargeTime);
        when(charges.findByProviderOrderId("rev-ord-1")).thenReturn(Optional.of(charge));
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.empty());
        when(payments.findMerchantSavedPaymentMethod("cust-1")).thenReturn(Optional.of("pm-1"));

        service.confirmCharge("rev-ord-1");

        // The charge settles and the one subscription row is created ACTIVE with a rolling month.
        assertThat(charge.getStatus()).isEqualTo(SubscriptionCharge.Status.PAID);
        ArgumentCaptor<Subscription> saved = ArgumentCaptor.forClass(Subscription.class);
        verify(subscriptions).save(saved.capture());
        Subscription subscription = saved.getValue();
        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.ACTIVE);
        assertThat(subscription.getTier()).isEqualTo(MembershipTier.MONTHLY);
        assertThat(subscription.getSavedPaymentMethodRef()).isEqualTo("pm-1");
        assertThat(subscription.getCurrentPeriodEnd())
                .isEqualTo(Subscription.plusOneMonth(subscription.getCurrentPeriodStart()));
        assertThat(subscription.getNextChargeAt()).isEqualTo(subscription.getCurrentPeriodEnd());

        // The paid tier is granted through the ungated subscription path, audited, and the user notified.
        verify(memberships).applyTierForSubscription(42L, MembershipTier.MONTHLY, "uid-42");
        verify(audit)
                .record(
                        eq("uid-42"),
                        eq(AuditAction.SUBSCRIPTION_STARTED),
                        eq("Subscription"),
                        eq("42"),
                        any(Map.class));
        verify(notifier).subscriptionStarted(eq(42L), eq(MembershipTier.MONTHLY), anyString());
    }

    @Test
    void confirmChargeIsIdempotentOnRepeatWebhook() {
        Instant chargeTime = Instant.now();
        SubscriptionCharge charge =
                new SubscriptionCharge(42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, chargeTime);
        charge.setPaymentReference("revolut", "rev-ord-1", "cust-1", chargeTime);
        charge.markPaid(chargeTime, Subscription.plusOneMonth(chargeTime), chargeTime); // already settled
        when(charges.findByProviderOrderId("rev-ord-1")).thenReturn(Optional.of(charge));

        service.confirmCharge("rev-ord-1");

        verify(subscriptions, never()).save(any());
        verify(memberships, never()).applyTierForSubscription(anyLong(), any(), anyString());
        verify(notifier, never()).subscriptionStarted(anyLong(), any(), anyString());
    }

    @Test
    void confirmChargeIgnoresUnknownProviderOrder() {
        when(charges.findByProviderOrderId("not-ours")).thenReturn(Optional.empty());

        service.confirmCharge("not-ours");

        verify(users, never()).lockForUpdate(anyLong());
        verify(subscriptions, never()).save(any());
    }

    @Test
    void confirmChargeResubscribeResetsExistingRow() {
        // The account cancelled earlier and subscribed again: the SAME row resets rather than duplicating.
        Instant past = Instant.now().minus(Duration.ofDays(40));
        Subscription existing = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", past);
        existing.cancelAtPeriodEnd(past.plus(Duration.ofDays(5)));
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(existing));

        Instant chargeTime = Instant.now();
        SubscriptionCharge charge = new SubscriptionCharge(
                42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.DIAMOND, 1999, chargeTime);
        charge.setPaymentReference("revolut", "rev-ord-9", "cust-1", chargeTime);
        when(charges.findByProviderOrderId("rev-ord-9")).thenReturn(Optional.of(charge));
        when(payments.findMerchantSavedPaymentMethod("cust-1")).thenReturn(Optional.of("pm-2"));

        service.confirmCharge("rev-ord-9");

        verify(subscriptions, never()).save(any()); // reset in place, no second row
        assertThat(existing.getStatus()).isEqualTo(SubscriptionStatus.ACTIVE);
        assertThat(existing.getTier()).isEqualTo(MembershipTier.DIAMOND);
        assertThat(existing.getCanceledAt()).isNull();
        assertThat(existing.getSavedPaymentMethodRef()).isEqualTo("pm-2");
        verify(memberships).applyTierForSubscription(42L, MembershipTier.DIAMOND, "uid-42");
    }

    @Test
    void confirmChargeHealsFailedRenewalTheProviderLaterSettles() {
        // A renewal the sync path saw fail, but the webhook reports paid: real money → real period.
        Instant subscribed = Instant.now().minus(Duration.ofDays(35));
        Subscription subscription = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", subscribed);
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(subscription));

        Instant attemptTime = Instant.now().minus(Duration.ofHours(2));
        SubscriptionCharge charge = new SubscriptionCharge(
                42L, SubscriptionCharge.Kind.RENEWAL, MembershipTier.MONTHLY, 999, attemptTime);
        charge.coverPeriod(
                subscription.getCurrentPeriodEnd(),
                Subscription.plusOneMonth(subscription.getCurrentPeriodEnd()),
                attemptTime);
        charge.setPaymentReference("revolut", "rev-ren-1", "cust-1", attemptTime);
        charge.markFailed(attemptTime);
        when(charges.findByProviderOrderId("rev-ren-1")).thenReturn(Optional.of(charge));

        Instant oldPeriodEnd = subscription.getCurrentPeriodEnd();
        service.confirmCharge("rev-ren-1");

        assertThat(charge.getStatus()).isEqualTo(SubscriptionCharge.Status.PAID);
        assertThat(subscription.getCurrentPeriodStart()).isEqualTo(oldPeriodEnd);
        assertThat(subscription.getCurrentPeriodEnd()).isEqualTo(Subscription.plusOneMonth(oldPeriodEnd));
        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.ACTIVE);
        verify(memberships).applyTierForSubscription(42L, MembershipTier.MONTHLY, "uid-42");
        verify(notifier).renewalSucceeded(eq(42L), eq(MembershipTier.MONTHLY), anyString());
    }

    // ------------------------------------------------------------------ cancel

    @Test
    void cancelStopsRenewalsAndParksDowngradeAtPeriodEnd() {
        Subscription subscription = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", Instant.now());
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(subscription));

        Subscription result = service.cancel(CALLER);

        assertThat(result.getStatus()).isEqualTo(SubscriptionStatus.CANCELED);
        assertThat(result.getCanceledAt()).isNotNull();
        // The "due" pointer parks at the period end — where the scheduler performs the downgrade.
        assertThat(result.getNextChargeAt()).isEqualTo(subscription.getCurrentPeriodEnd());
        // The tier is untouched here: access is honoured until the period end.
        verify(memberships, never()).applyTierForSubscription(anyLong(), any(), anyString());
        verify(audit)
                .record(
                        eq("uid-42"),
                        eq(AuditAction.SUBSCRIPTION_CANCELED),
                        eq("Subscription"),
                        eq("42"),
                        any(Map.class));
    }

    @Test
    void cancelIsIdempotent() {
        Subscription subscription = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", Instant.now());
        subscription.cancelAtPeriodEnd(Instant.now());
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(subscription));

        Subscription result = service.cancel(CALLER);

        assertThat(result.getStatus()).isEqualTo(SubscriptionStatus.CANCELED);
        verify(audit, never()).record(anyString(), any(), anyString(), anyString(), any(Map.class));
    }

    @Test
    void cancelWithoutSubscriptionIs404() {
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.cancel(CALLER)).isInstanceOf(ResourceNotFoundException.class);
    }
}
