package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.config.MembershipProperties;
import com.teammarhaba.backend.payments.PaymentOrder;
import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.payments.PaymentProviderException;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.BadRequestException;
import com.teammarhaba.backend.web.ConflictException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import jakarta.persistence.EntityManager;
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
    private EntityManager entityManager;
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
        entityManager = mock(EntityManager.class); // refresh() is a no-op — race tests stub it explicitly
        // Server-side membership flag ON here; the flag-OFF 404 behaviour has its own tests below.
        service = new SubscriptionService(
                subscriptions, charges, memberships, users, payments, audit, notifier,
                new MembershipProperties(true), entityManager);

        user = mock(User.class);
        when(user.getId()).thenReturn(42L);
        when(user.getEmail()).thenReturn("sub@example.com");
        when(user.getPhone()).thenReturn("+447700900000");
        when(user.getDisplayName()).thenReturn("Sub Scriber");
        when(user.getFirebaseUid()).thenReturn("uid-42");
        when(users.provision(any())).thenReturn(user);
        when(users.getById(42L)).thenReturn(user);
        when(users.findAnyById(42L)).thenReturn(Optional.of(user)); // active account (isDeleted=false)
        when(payments.name()).thenReturn("revolut");
        when(payments.currency()).thenReturn("GBP"); // the seam-exposed charge currency (TM-629)

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
        when(payments.createCustomer("sub@example.com", "+447700900000", "Sub Scriber")).thenReturn("cust-1");
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
        when(payments.createCustomer(any(), any(), any())).thenReturn("cust-1");
        when(payments.createOrderForCustomer(eq(1999), eq("GBP"), anyString(), eq("cust-1")))
                .thenReturn(new PaymentOrder("rev-ord-2", "tok-2"));

        SubscriptionCheckout result = service.checkout(CALLER, MembershipTier.DIAMOND);

        assertThat(result.amountPence()).isEqualTo(1999);
    }

    @Test
    void checkoutRejectsFreeBaseTier() {
        assertThatThrownBy(() -> service.checkout(CALLER, MembershipTier.PAY_PER_EVENT))
                .isInstanceOf(BadRequestException.class);
        verify(payments, never()).createCustomer(any(), any(), any());
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
        verify(payments, never()).createCustomer(any(), any(), any()); // reused, not re-registered
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
        when(payments.createCustomer(any(), any(), any())).thenReturn("cust-1");
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
    void confirmChargeRefundsAnInitialSettleForASoftDeletedBuyerInsteadOf500Looping() {
        // TM-728 (finding 1): a soft-deleted buyer's PENDING INITIAL charge settles. activate()'s
        // restricted getById would throw for a tombstoned account, 500-looping the webhook forever with
        // the money captured but never activated and never refunded. The captured money must instead be
        // flagged REFUND_DUE and refunded — never a crash, never a silent drop.
        Instant chargeTime = Instant.now();
        SubscriptionCharge charge =
                new SubscriptionCharge(42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, chargeTime);
        charge.setPaymentReference("revolut", "rev-ord-del", "cust-1", chargeTime);
        when(charges.findByProviderOrderId("rev-ord-del")).thenReturn(Optional.of(charge));
        User deleted = mock(User.class);
        when(deleted.isDeleted()).thenReturn(true);
        when(users.findAnyById(42L)).thenReturn(Optional.of(deleted));

        boolean matched = service.confirmCharge("rev-ord-del");

        assertThat(matched).isTrue(); // resolved to our ledger — the webhook is acked, not redelivered
        // The captured money is owed back, not swallowed: REFUND_DUE + provider refund → REFUNDED.
        verify(payments).refund(eq("rev-ord-del"), eq(999), eq("GBP"), anyString());
        assertThat(charge.getStatus()).isEqualTo(SubscriptionCharge.Status.REFUNDED);
        // Never activated for a tombstoned account: no subscription row, no tier grant, no notification.
        verify(subscriptions, never()).save(any());
        verify(memberships, never()).applyTierForSubscription(anyLong(), any(), anyString());
        verify(notifier, never()).subscriptionStarted(anyLong(), any(), anyString());
    }

    @Test
    void confirmChargeRefundsASecondInitialSettleWhenTheSubscriptionIsAlreadyActive() {
        // TM-728 (finding 2): a second INITIAL charge settles while the account is ALREADY actively
        // subscribed — duplicate money (the mirror of the handled SUPERSEDED refund case). activate()
        // would silently reset the live period, swallowing this paid month. It must instead be flagged
        // REFUND_DUE and the provider refund attempted; a failing refund keeps the debt visible.
        Subscription active = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", Instant.now());
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(active));

        Instant chargeTime = Instant.now();
        SubscriptionCharge charge =
                new SubscriptionCharge(42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, chargeTime);
        charge.setPaymentReference("revolut", "rev-ord-dup", "cust-1", chargeTime);
        when(charges.findByProviderOrderId("rev-ord-dup")).thenReturn(Optional.of(charge));
        doThrow(new PaymentProviderException("gateway down"))
                .when(payments)
                .refund(any(), anyInt(), any(), any());

        boolean matched = service.confirmCharge("rev-ord-dup");

        assertThat(matched).isTrue();
        // The refund was ATTEMPTED against the captured order; the failed attempt keeps the debt as
        // REFUND_DUE (the sweeper's queue) rather than swallowing the paid month.
        verify(payments).refund(eq("rev-ord-dup"), eq(999), eq("GBP"), anyString());
        assertThat(charge.getStatus()).isEqualTo(SubscriptionCharge.Status.REFUND_DUE);
        // The live subscription is untouched — its period is NOT reset by the duplicate settle.
        assertThat(active.getStatus()).isEqualTo(SubscriptionStatus.ACTIVE);
        verify(memberships, never()).applyTierForSubscription(anyLong(), any(), anyString());
        verify(notifier, never()).subscriptionStarted(anyLong(), any(), anyString());
    }

    // ------------------------------------------------------------------ decline/fail webhook (TM-634)

    @Test
    void failChargeMarksAPendingInitialChargeFailedWithoutActivating() {
        // TM-634: a declined INITIAL widget payment (ORDER_PAYMENT_DECLINED/FAILED) marks the PENDING charge
        // terminal FAILED and — crucially — must NOT activate the subscription (no save, no tier grant, no
        // "subscription started" notification).
        Instant chargeTime = Instant.now();
        SubscriptionCharge charge =
                new SubscriptionCharge(42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, chargeTime);
        charge.setPaymentReference("revolut", "rev-ord-df", "cust-1", chargeTime);
        when(charges.findByProviderOrderId("rev-ord-df")).thenReturn(Optional.of(charge));

        boolean matched = service.failCharge("rev-ord-df");

        assertThat(matched).isTrue();
        assertThat(charge.getStatus()).isEqualTo(SubscriptionCharge.Status.FAILED);
        verify(users).lockForUpdate(42L); // serialised with confirms/renewals on this buyer
        verify(subscriptions, never()).save(any());
        verify(memberships, never()).applyTierForSubscription(anyLong(), any(), anyString());
        verify(notifier, never()).subscriptionStarted(anyLong(), any(), anyString());
    }

    @Test
    void failChargeLeavesAnAlreadyPaidChargeUntouched() {
        // A decline arriving after a settle must never overwrite a PAID (settled) charge.
        Instant chargeTime = Instant.now();
        SubscriptionCharge charge =
                new SubscriptionCharge(42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, chargeTime);
        charge.setPaymentReference("revolut", "rev-ord-paid", "cust-1", chargeTime);
        charge.markPaid(chargeTime, Subscription.plusOneMonth(chargeTime), chargeTime);
        when(charges.findByProviderOrderId("rev-ord-paid")).thenReturn(Optional.of(charge));

        boolean matched = service.failCharge("rev-ord-paid");

        assertThat(matched).isTrue();
        assertThat(charge.getStatus()).isEqualTo(SubscriptionCharge.Status.PAID); // untouched
    }

    @Test
    void failChargeIgnoresUnknownProviderOrder() {
        // Not a subscription charge — the bridge already tried the event-order ledger.
        when(charges.findByProviderOrderId("not-ours")).thenReturn(Optional.empty());

        assertThat(service.failCharge("not-ours")).isFalse();
        verify(users, never()).lockForUpdate(anyLong());
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

    // ------------------------------------------------------------------ server-side flag (TM-623)

    /** A service wired exactly as prod-with-the-flag-off boots: money paths must not exist. */
    private SubscriptionService gatedService() {
        return new SubscriptionService(
                subscriptions, charges, memberships, users, payments, audit, notifier,
                new MembershipProperties(false), entityManager);
    }

    @Test
    void checkoutIs404WhileTheServerSideMembershipFlagIsOff() {
        assertThatThrownBy(() -> gatedService().checkout(CALLER, MembershipTier.MONTHLY))
                .isInstanceOf(ResourceNotFoundException.class);
        // The gate fires before ANYTHING happens: no provider customer, no provider order, no ledger row.
        verifyNoInteractions(payments, charges);
    }

    @Test
    void cancelIs404WhileTheServerSideMembershipFlagIsOff() {
        assertThatThrownBy(() -> gatedService().cancel(CALLER))
                .isInstanceOf(ResourceNotFoundException.class);
        verify(audit, never()).record(anyString(), any(), anyString(), anyString(), any(Map.class));
    }

    @Test
    void confirmChargeStillSettlesWhileTheFlagIsOff() {
        // A flag ROLLBACK must not strand in-flight money: a charge legitimately opened while the flag
        // was on still settles (and activates) when its webhook arrives after the flag went off.
        Instant chargeTime = Instant.now();
        SubscriptionCharge charge =
                new SubscriptionCharge(42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, chargeTime);
        charge.setPaymentReference("revolut", "rev-ord-1", "cust-1", chargeTime);
        when(charges.findByProviderOrderId("rev-ord-1")).thenReturn(Optional.of(charge));
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.empty());
        when(payments.findMerchantSavedPaymentMethod("cust-1")).thenReturn(Optional.of("pm-1"));

        gatedService().confirmCharge("rev-ord-1");

        assertThat(charge.getStatus()).isEqualTo(SubscriptionCharge.Status.PAID);
        verify(memberships).applyTierForSubscription(42L, MembershipTier.MONTHLY, "uid-42");
    }

    // ------------------------------------------------------------------ re-point voids the old order (TM-623)

    @Test
    void repointVoidsTheSupersededProviderOrder() {
        // The abandoned attempt's provider order is cancelled at the gateway BEFORE the row forgets it,
        // so a stale open widget can no longer capture money that would reconcile to nothing.
        Instant earlier = Instant.now().minus(Duration.ofHours(1));
        SubscriptionCharge abandoned =
                new SubscriptionCharge(42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, earlier);
        abandoned.setPaymentReference("revolut", "rev-old", "cust-1", earlier);
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.empty());
        when(charges.findFirstByUserIdAndKindAndStatus(
                        42L, SubscriptionCharge.Kind.INITIAL, SubscriptionCharge.Status.PENDING))
                .thenReturn(Optional.of(abandoned));
        when(payments.createCustomer(any(), any(), any())).thenReturn("cust-1");
        when(payments.createOrderForCustomer(eq(999), eq("GBP"), anyString(), eq("cust-1")))
                .thenReturn(new PaymentOrder("rev-new", "tok-new"));

        service.checkout(CALLER, MembershipTier.MONTHLY);

        verify(payments).cancelOrder("rev-old");
        assertThat(abandoned.getProviderOrderId()).isEqualTo("rev-new");
    }

    @Test
    void repointSurvivesAFailedVoidKeepingTheOldOrderResolvable() {
        // The void is best-effort: the gateway refusing it (already paid / transient) must not block
        // the caller's new checkout. But the refused void means the old order may STILL settle — so
        // its refs must stay resolvable (a frozen SUPERSEDED row), never nulled into a state where the
        // late settle matches no ledger and captured money silently vanishes (TM-625).
        Instant earlier = Instant.now().minus(Duration.ofHours(1));
        SubscriptionCharge abandoned =
                new SubscriptionCharge(42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, earlier);
        abandoned.setPaymentReference("revolut", "rev-old", "cust-1", earlier);
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.empty());
        when(charges.findFirstByUserIdAndKindAndStatus(
                        42L, SubscriptionCharge.Kind.INITIAL, SubscriptionCharge.Status.PENDING))
                .thenReturn(Optional.of(abandoned));
        doThrow(new PaymentProviderException("already completed")).when(payments).cancelOrder("rev-old");
        when(payments.createCustomer(any(), any(), any())).thenReturn("cust-1");
        when(payments.createOrderForCustomer(eq(999), eq("GBP"), anyString(), eq("cust-1")))
                .thenReturn(new PaymentOrder("rev-new", "tok-new"));

        SubscriptionCheckout result = service.checkout(CALLER, MembershipTier.MONTHLY);

        // The new checkout proceeds normally…
        assertThat(result.paymentToken()).isEqualTo("tok-new");
        // …while the unvoidable old attempt is frozen with its provider refs KEPT — the webhook can
        // still resolve "rev-old", and a fresh row (not this one) carries the new attempt.
        assertThat(abandoned.getStatus()).isEqualTo(SubscriptionCharge.Status.SUPERSEDED);
        assertThat(abandoned.getProviderOrderId()).isEqualTo("rev-old");
        ArgumentCaptor<SubscriptionCharge> saved = ArgumentCaptor.forClass(SubscriptionCharge.class);
        verify(charges).save(saved.capture());
        assertThat(saved.getValue().getStatus()).isEqualTo(SubscriptionCharge.Status.PENDING);
        assertThat(saved.getValue().getProviderOrderId()).isEqualTo("rev-new");
    }

    // ------------------------------------------------------------------ superseded late settle (TM-625)

    @Test
    void lateSettleOfASupersededOrderActivatesWhenNoActiveSubscriptionExists() {
        // The deterministic interleaving from the re-verify: Tab A pays order O1 → Tab B re-enters
        // checkout, the void of O1 is refused (mid-payment), the charge re-points to O2 → O1's settle
        // webhook arrives. The money was CAPTURED; the customer has no active subscription — so the
        // settle must ACTIVATE (they get what they paid for), not be silently dropped and 2xx-acked
        // (the original silent-money-loss outcome).
        Instant earlier = Instant.now().minus(Duration.ofHours(1));
        SubscriptionCharge abandoned =
                new SubscriptionCharge(42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, earlier);
        abandoned.setPaymentReference("revolut", "rev-old", "cust-1", earlier);
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.empty());
        when(charges.findFirstByUserIdAndKindAndStatus(
                        42L, SubscriptionCharge.Kind.INITIAL, SubscriptionCharge.Status.PENDING))
                .thenReturn(Optional.of(abandoned));
        doThrow(new PaymentProviderException("payment in progress")).when(payments).cancelOrder("rev-old");
        when(payments.createCustomer(any(), any(), any())).thenReturn("cust-1");
        when(payments.createOrderForCustomer(eq(999), eq("GBP"), anyString(), eq("cust-1")))
                .thenReturn(new PaymentOrder("rev-new", "tok-new"));
        service.checkout(CALLER, MembershipTier.MONTHLY); // leaves "rev-old" SUPERSEDED, refs kept

        // The late ORDER_COMPLETED for the OLD order — before the fix this matched nothing.
        when(charges.findByProviderOrderId("rev-old")).thenReturn(Optional.of(abandoned));
        when(payments.findMerchantSavedPaymentMethod("cust-1")).thenReturn(Optional.of("pm-1"));

        boolean matched = service.confirmCharge("rev-old");

        assertThat(matched).isTrue(); // resolved to OUR ledger — the webhook bridge won't flag it
        assertThat(abandoned.getStatus()).isEqualTo(SubscriptionCharge.Status.PAID);
        verify(subscriptions).save(any(Subscription.class)); // a real activation happened
        verify(memberships).applyTierForSubscription(42L, MembershipTier.MONTHLY, "uid-42");
        verify(payments, never()).refund(any(), anyInt(), any(), any()); // service delivered — no refund
    }

    @Test
    void lateSettleOfASupersededOrderIsFlaggedRefundDueWhenTheSubscriptionIsAlreadyActive() {
        // Same interleaving, other ordering: the REPLACEMENT order settled first and activated the
        // subscription — the superseded order's late settle is duplicate money. It must be flagged
        // REFUND_DUE and the provider refund attempted; a failing refund keeps the flag (the sweeper's
        // work queue) rather than reverting to the silent drop.
        Instant earlier = Instant.now().minus(Duration.ofHours(1));
        SubscriptionCharge superseded =
                new SubscriptionCharge(42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, earlier);
        superseded.setPaymentReference("revolut", "rev-old", "cust-1", earlier);
        superseded.markSuperseded(earlier);
        when(charges.findByProviderOrderId("rev-old")).thenReturn(Optional.of(superseded));
        // The new attempt already activated: an ACTIVE subscription exists.
        Subscription active = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", Instant.now());
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(active));
        doThrow(new PaymentProviderException("gateway down"))
                .when(payments)
                .refund(any(), anyInt(), any(), any());

        boolean matched = service.confirmCharge("rev-old");

        assertThat(matched).isTrue();
        // The refund was ATTEMPTED against the captured order, and the failed attempt keeps the debt
        // visible as REFUND_DUE — never PAID (no double period), never silently dropped.
        verify(payments).refund(eq("rev-old"), eq(999), eq("GBP"), anyString());
        assertThat(superseded.getStatus()).isEqualTo(SubscriptionCharge.Status.REFUND_DUE);
        assertThat(active.getStatus()).isEqualTo(SubscriptionStatus.ACTIVE); // untouched
        verify(memberships, never()).applyTierForSubscription(anyLong(), any(), anyString());
    }

    // ------------------------------------------------------------------ heal must not resurrect (TM-623)

    @Test
    void healRenewalDoesNotResurrectAUserCanceledSubscription() {
        // The consent sequence: renewal fails → user CANCELS (withdraws the mandate) → the provider's
        // late webhook reports the original charge settled. The paid window must be honoured, but
        // auto-renewal must NOT re-arm against a card whose owner explicitly cancelled.
        Instant subscribed = Instant.now().minus(Duration.ofDays(35));
        Subscription subscription = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", subscribed);
        Instant oldPeriodEnd = subscription.getCurrentPeriodEnd();

        Instant attemptTime = Instant.now().minus(Duration.ofHours(3));
        SubscriptionCharge charge = new SubscriptionCharge(
                42L, SubscriptionCharge.Kind.RENEWAL, MembershipTier.MONTHLY, 999, attemptTime);
        charge.coverPeriod(oldPeriodEnd, Subscription.plusOneMonth(oldPeriodEnd), attemptTime);
        charge.setPaymentReference("revolut", "rev-ren-9", "cust-1", attemptTime);
        charge.markFailed(attemptTime);

        subscription.cancelAtPeriodEnd(Instant.now().minus(Duration.ofHours(1))); // the user's cancel
        Instant canceledAt = subscription.getCanceledAt();

        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(subscription));
        when(charges.findByProviderOrderId("rev-ren-9")).thenReturn(Optional.of(charge));

        service.confirmCharge("rev-ren-9");

        // The money moved, so the paid window exists…
        assertThat(charge.getStatus()).isEqualTo(SubscriptionCharge.Status.PAID);
        assertThat(subscription.getCurrentPeriodEnd()).isEqualTo(Subscription.plusOneMonth(oldPeriodEnd));
        // …but the cancel stands: still CANCELED, canceledAt untouched, and the "due" pointer parked at
        // the NEW period end is the DOWNGRADE pass, not a renewal charge.
        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.CANCELED);
        assertThat(subscription.getCanceledAt()).isEqualTo(canceledAt);
        assertThat(subscription.getNextChargeAt()).isEqualTo(subscription.getCurrentPeriodEnd());
    }

    // ------------------------------------------------------------------ duplicate-delivery race (TM-623)

    @Test
    void concurrentDuplicateWebhookDeliveryConfirmsExactlyOnce() {
        // Two deliveries of the same settle event race: the loser blocks on the user lock while the
        // winner commits PAID. The loser's pre-lock read is a stale L1 snapshot (still PENDING) — only
        // the refresh under the lock reveals the committed PAID and makes the idempotency check real.
        Instant chargeTime = Instant.now();
        SubscriptionCharge charge =
                new SubscriptionCharge(42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, chargeTime);
        charge.setPaymentReference("revolut", "rev-ord-1", "cust-1", chargeTime);
        when(charges.findByProviderOrderId("rev-ord-1")).thenReturn(Optional.of(charge));
        // Simulate "the other delivery committed while we waited for the lock": the refresh loads the
        // committed PAID state into the managed instance.
        doAnswer(inv -> {
                    charge.markPaid(chargeTime, Subscription.plusOneMonth(chargeTime), chargeTime);
                    return null;
                })
                .when(entityManager)
                .refresh(charge);

        service.confirmCharge("rev-ord-1");

        // The losing delivery is a clean no-op: no second activation, no tier grant, no notification.
        verify(subscriptions, never()).save(any());
        verify(memberships, never()).applyTierForSubscription(anyLong(), any(), anyString());
        verify(notifier, never()).subscriptionStarted(anyLong(), any(), anyString());
    }

    // ------------------------------------------------------------------ configured currency (TM-629)

    @Test
    void checkoutOpensTheProviderOrderInTheConfiguredCurrency() {
        // Regression for the dead config knob (review finding #22, TM-629): the Subscribe checkout must
        // charge in the SEAM-exposed currency, not a per-service hardcoded "GBP". On the pre-fix code
        // the EUR-only stub below never matches (the service asks for GBP regardless of config).
        when(payments.currency()).thenReturn("EUR");
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.empty());
        when(charges.findFirstByUserIdAndKindAndStatus(any(), any(), any())).thenReturn(Optional.empty());
        when(payments.createCustomer(any(), any(), any())).thenReturn("cust-1");
        when(payments.createOrderForCustomer(eq(999), eq("EUR"), anyString(), eq("cust-1")))
                .thenReturn(new PaymentOrder("rev-eur", "tok-eur"));

        SubscriptionCheckout result = service.checkout(CALLER, MembershipTier.MONTHLY);

        assertThat(result.paymentToken()).isEqualTo("tok-eur");
        verify(payments).createOrderForCustomer(eq(999), eq("EUR"), anyString(), eq("cust-1"));
        verify(payments, never()).createOrderForCustomer(anyInt(), eq("GBP"), anyString(), anyString());
    }

    // ------------------------------------------------------------------ residual paid time (TM-629)

    @Test
    void resubscribeWhileCanceledWithPaidTimeLeftCreditsTheRemainder() {
        // Review findings #12/#19 (TM-629): "cancel day 1, re-subscribe day 2" used to reset the period
        // at the activation instant, silently swallowing ~29 already-paid days — the customer paid twice
        // for the overlap. The unexpired remainder must now extend the fresh period.
        Instant subscribed = Instant.now().minus(Duration.ofDays(1));
        Subscription existing = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", subscribed);
        existing.cancelAtPeriodEnd(Instant.now()); // canceled with ~29 paid days left on the old window
        Instant oldPaidUntil = existing.getCurrentPeriodEnd();
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(existing));

        Instant chargeTime = Instant.now();
        SubscriptionCharge charge =
                new SubscriptionCharge(42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, chargeTime);
        charge.setPaymentReference("revolut", "rev-ord-re", "cust-1", chargeTime);
        when(charges.findByProviderOrderId("rev-ord-re")).thenReturn(Optional.of(charge));
        when(payments.findMerchantSavedPaymentMethod("cust-1")).thenReturn(Optional.of("pm-1"));

        service.confirmCharge("rev-ord-re");

        assertThat(existing.getStatus()).isEqualTo(SubscriptionStatus.ACTIVE);
        // activate() stamped currentPeriodStart with the activation instant; the new period end must be
        // one month from then PLUS exactly the remainder that was still paid for at that instant.
        Instant activationStart = existing.getCurrentPeriodStart();
        Instant expectedEnd = Subscription.plusOneMonth(activationStart)
                .plus(Duration.between(activationStart, oldPaidUntil));
        assertThat(existing.getCurrentPeriodEnd()).isEqualTo(expectedEnd);
        // Sanity: that is materially LONGER than the plain one-month reset the bug produced.
        assertThat(existing.getCurrentPeriodEnd())
                .isAfter(Subscription.plusOneMonth(activationStart).plus(Duration.ofDays(20)));
        assertThat(existing.getNextChargeAt()).isEqualTo(existing.getCurrentPeriodEnd());
    }

    @Test
    void resubscribeAfterTheCanceledPeriodExpiredStartsAPlainFreshMonth() {
        // The complement of the remainder credit (TM-629): a CANCELED subscription whose paid window
        // already ran out has nothing left to credit — the fresh period is exactly one month.
        Instant past = Instant.now().minus(Duration.ofDays(40));
        Subscription existing = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", past);
        existing.cancelAtPeriodEnd(past.plus(Duration.ofDays(5))); // period end ≈ 10 days ago
        when(subscriptions.findByUserId(42L)).thenReturn(Optional.of(existing));

        Instant chargeTime = Instant.now();
        SubscriptionCharge charge =
                new SubscriptionCharge(42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, chargeTime);
        charge.setPaymentReference("revolut", "rev-ord-exp", "cust-1", chargeTime);
        when(charges.findByProviderOrderId("rev-ord-exp")).thenReturn(Optional.of(charge));
        when(payments.findMerchantSavedPaymentMethod("cust-1")).thenReturn(Optional.of("pm-1"));

        service.confirmCharge("rev-ord-exp");

        assertThat(existing.getStatus()).isEqualTo(SubscriptionStatus.ACTIVE);
        assertThat(existing.getCurrentPeriodEnd())
                .isEqualTo(Subscription.plusOneMonth(existing.getCurrentPeriodStart()));
    }
}
