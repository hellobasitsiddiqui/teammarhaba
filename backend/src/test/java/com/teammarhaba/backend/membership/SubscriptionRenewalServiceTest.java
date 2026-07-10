package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;
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
import com.teammarhaba.backend.config.SubscriptionProperties;
import com.teammarhaba.backend.payments.PaymentOrder;
import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.payments.PaymentProviderException;
import com.teammarhaba.backend.payments.SavedMethodCharge;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * Unit coverage of the renewal + dunning engine (TM-620) with NO live payment calls — the mocked
 * {@link PaymentProvider} plays the gateway. Exercises the full policy: a due renewal charged
 * off-session and extended on success; a failure entering dunning (PAST_DUE + scheduled retry +
 * notification); a retry success returning to ACTIVE; dunning exhaustion lapsing the subscription and
 * downgrading the membership to pay-per-event; and a user-cancelled subscription reaching its period
 * end being downgraded without any charge attempt.
 */
class SubscriptionRenewalServiceTest {

    private SubscriptionRepository subscriptions;
    private SubscriptionChargeRepository charges;
    private MembershipService memberships;
    private UserService users;
    private PaymentProvider payments;
    private AuditService audit;
    private SubscriptionNotifier notifier;
    private SubscriptionRenewalService service;
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
        // Dunning policy under test: 3 retries, 48h apart.
        service = new SubscriptionRenewalService(
                subscriptions, charges, memberships, users, payments, audit, notifier,
                new SubscriptionProperties(3, 48));

        user = mock(User.class);
        when(user.getId()).thenReturn(42L);
        when(user.getFirebaseUid()).thenReturn("uid-42");
        when(users.getById(42L)).thenReturn(user);
        when(payments.name()).thenReturn("revolut");
        when(charges.save(any(SubscriptionCharge.class))).thenAnswer(inv -> inv.getArgument(0));
    }

    /** An ACTIVE subscription whose renewal fell due (subscribed >1 month ago), with a saved card. */
    private Subscription dueActiveSubscription() {
        Instant subscribed = Instant.now().minus(Duration.ofDays(35));
        Subscription subscription = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", subscribed);
        subscription.savePaymentMethodRef("pm-1", subscribed);
        when(subscriptions.findById(7L)).thenReturn(Optional.of(subscription));
        return subscription;
    }

    // ------------------------------------------------------------------ renewal success

    @Test
    void dueRenewalChargesSavedCardAndExtendsPeriod() {
        Subscription subscription = dueActiveSubscription();
        Instant oldPeriodEnd = subscription.getCurrentPeriodEnd();
        when(payments.createOrderForCustomer(eq(999), eq("GBP"), anyString(), eq("cust-1")))
                .thenReturn(new PaymentOrder("rev-ren-1", "tok"));
        when(payments.payWithSavedMethod("rev-ren-1", "pm-1")).thenReturn(new SavedMethodCharge("completed", true));

        boolean acted = service.processOne(7L);

        assertThat(acted).isTrue();
        // Anniversary billing: the new window starts exactly at the old period END, not at charge time.
        assertThat(subscription.getCurrentPeriodStart()).isEqualTo(oldPeriodEnd);
        assertThat(subscription.getCurrentPeriodEnd()).isEqualTo(Subscription.plusOneMonth(oldPeriodEnd));
        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.ACTIVE);
        assertThat(subscription.getRetryCount()).isZero();
        assertThat(subscription.getNextChargeAt()).isEqualTo(subscription.getCurrentPeriodEnd());

        // A PAID RENEWAL ledger row covering exactly the window that was bought.
        ArgumentCaptor<SubscriptionCharge> saved = ArgumentCaptor.forClass(SubscriptionCharge.class);
        verify(charges).save(saved.capture());
        SubscriptionCharge charge = saved.getValue();
        assertThat(charge.getKind()).isEqualTo(SubscriptionCharge.Kind.RENEWAL);
        assertThat(charge.getStatus()).isEqualTo(SubscriptionCharge.Status.PAID);
        assertThat(charge.getPeriodStart()).isEqualTo(oldPeriodEnd);
        assertThat(charge.getPeriodEnd()).isEqualTo(Subscription.plusOneMonth(oldPeriodEnd));

        verify(users).lockForUpdate(42L);
        verify(notifier).renewalSucceeded(eq(42L), eq(MembershipTier.MONTHLY), anyString());
        verify(audit)
                .record(
                        eq("uid-42"),
                        eq(AuditAction.SUBSCRIPTION_RENEWED),
                        eq("Subscription"),
                        eq("42"),
                        any(Map.class));
    }

    @Test
    void notDueSubscriptionIsANoOp() {
        // Subscribed just now → next charge a month away → nothing due.
        Subscription subscription = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", Instant.now());
        when(subscriptions.findById(7L)).thenReturn(Optional.of(subscription));

        assertThat(service.processOne(7L)).isFalse();
        verify(payments, never()).payWithSavedMethod(anyString(), anyString());
    }

    // ------------------------------------------------------------------ dunning

    @Test
    void failedRenewalEntersDunningKeepingTheTier() {
        Subscription subscription = dueActiveSubscription();
        Instant oldPeriodEnd = subscription.getCurrentPeriodEnd();
        when(payments.createOrderForCustomer(anyInt(), anyString(), anyString(), anyString()))
                .thenReturn(new PaymentOrder("rev-ren-2", "tok"));
        when(payments.payWithSavedMethod("rev-ren-2", "pm-1")).thenReturn(new SavedMethodCharge("declined", false));

        service.processOne(7L);

        // PAST_DUE with one attempt counted and the retry ~48h out; the paid window is NOT extended.
        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.PAST_DUE);
        assertThat(subscription.getRetryCount()).isEqualTo(1);
        assertThat(subscription.getCurrentPeriodEnd()).isEqualTo(oldPeriodEnd);
        assertThat(subscription.getNextChargeAt()).isAfter(Instant.now().plus(Duration.ofHours(47)));
        // The tier is kept during dunning — no downgrade call.
        verify(memberships, never()).applyTierForSubscription(anyLong(), any(), anyString());
        verify(notifier).renewalFailed(eq(42L), eq(MembershipTier.MONTHLY), anyString());

        ArgumentCaptor<SubscriptionCharge> saved = ArgumentCaptor.forClass(SubscriptionCharge.class);
        verify(charges).save(saved.capture());
        assertThat(saved.getValue().getStatus()).isEqualTo(SubscriptionCharge.Status.FAILED);
    }

    @Test
    void providerExceptionCountsAsFailedAttempt() {
        Subscription subscription = dueActiveSubscription();
        when(payments.createOrderForCustomer(anyInt(), anyString(), anyString(), anyString()))
                .thenThrow(new PaymentProviderException("gateway down"));

        boolean acted = service.processOne(7L);

        // A gateway outage enters dunning rather than blowing up the pass.
        assertThat(acted).isTrue();
        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.PAST_DUE);
        assertThat(subscription.getRetryCount()).isEqualTo(1);
    }

    @Test
    void dunningRetrySuccessReturnsToActive() {
        Subscription subscription = dueActiveSubscription();
        Instant oldPeriodEnd = subscription.getCurrentPeriodEnd();
        // Two failed attempts already; the retry now due succeeds.
        subscription.markPastDue(Instant.now().minus(Duration.ofHours(1)), Instant.now());
        subscription.markPastDue(Instant.now().minus(Duration.ofMinutes(5)), Instant.now());
        when(payments.createOrderForCustomer(anyInt(), anyString(), anyString(), anyString()))
                .thenReturn(new PaymentOrder("rev-ren-3", "tok"));
        when(payments.payWithSavedMethod("rev-ren-3", "pm-1")).thenReturn(new SavedMethodCharge("completed", true));

        service.processOne(7L);

        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.ACTIVE);
        assertThat(subscription.getRetryCount()).isZero(); // dunning episode over
        assertThat(subscription.getCurrentPeriodStart()).isEqualTo(oldPeriodEnd);
    }

    @Test
    void dunningExhaustionLapsesAndDowngradesToPayPerEvent() {
        Subscription subscription = dueActiveSubscription();
        // All 3 retries already spent (retryCount == maxRetries) — the next failure is terminal.
        subscription.markPastDue(Instant.now().minus(Duration.ofDays(6)), Instant.now());
        subscription.markPastDue(Instant.now().minus(Duration.ofDays(4)), Instant.now());
        subscription.markPastDue(Instant.now().minus(Duration.ofDays(2)), Instant.now());
        when(payments.createOrderForCustomer(anyInt(), anyString(), anyString(), anyString()))
                .thenReturn(new PaymentOrder("rev-ren-4", "tok"));
        when(payments.payWithSavedMethod("rev-ren-4", "pm-1")).thenReturn(new SavedMethodCharge("declined", false));

        service.processOne(7L);

        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.CANCELED);
        assertThat(subscription.getNextChargeAt()).isNull(); // nothing pending any more
        verify(memberships).applyTierForSubscription(42L, MembershipTier.PAY_PER_EVENT, "uid-42");
        verify(notifier).subscriptionEnded(eq(42L), eq(MembershipTier.MONTHLY), eq(true), anyString());
        verify(audit)
                .record(
                        eq("uid-42"),
                        eq(AuditAction.SUBSCRIPTION_LAPSED),
                        eq("Subscription"),
                        eq("42"),
                        any(Map.class));
    }

    @Test
    void missingSavedCardEntersDunningWithoutChargeCall() {
        Subscription subscription = dueActiveSubscription();
        subscription.savePaymentMethodRef(null, Instant.now().minus(Duration.ofDays(35)));
        when(payments.findMerchantSavedPaymentMethod("cust-1")).thenReturn(Optional.empty());

        service.processOne(7L);

        // No method to charge → a failed attempt (dunning), never a charge call or a crash.
        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.PAST_DUE);
        verify(payments, never()).payWithSavedMethod(anyString(), anyString());
    }

    // ------------------------------------------------------------------ cancel reaching period end

    @Test
    void canceledSubscriptionPastPeriodEndDowngradesWithoutCharging() {
        // Subscribed 35 days ago, cancelled 20 days ago: the paid month has now run out.
        Instant subscribed = Instant.now().minus(Duration.ofDays(35));
        Subscription subscription = new Subscription(42L, MembershipTier.DIAMOND, "revolut", "cust-1", subscribed);
        subscription.savePaymentMethodRef("pm-1", subscribed);
        subscription.cancelAtPeriodEnd(Instant.now().minus(Duration.ofDays(20)));
        when(subscriptions.findById(7L)).thenReturn(Optional.of(subscription));

        boolean acted = service.processOne(7L);

        assertThat(acted).isTrue();
        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.CANCELED);
        assertThat(subscription.getNextChargeAt()).isNull();
        // The promised downgrade — and absolutely no renewal charge on a cancelled subscription.
        verify(memberships).applyTierForSubscription(42L, MembershipTier.PAY_PER_EVENT, "uid-42");
        verify(payments, never()).createOrderForCustomer(anyInt(), anyString(), anyString(), anyString());
        verify(payments, never()).payWithSavedMethod(anyString(), anyString());
        verify(notifier).subscriptionEnded(eq(42L), eq(MembershipTier.DIAMOND), eq(false), anyString());
    }

    @Test
    void canceledSubscriptionStillInsidePaidPeriodIsNotTouched() {
        // Cancelled today with three weeks of paid time left: nothing due yet.
        Subscription subscription = new Subscription(
                42L, MembershipTier.MONTHLY, "revolut", "cust-1", Instant.now().minus(Duration.ofDays(7)));
        subscription.cancelAtPeriodEnd(Instant.now());
        when(subscriptions.findById(7L)).thenReturn(Optional.of(subscription));

        assertThat(service.processOne(7L)).isFalse();
        verify(memberships, never()).applyTierForSubscription(anyLong(), any(), anyString());
    }
}
