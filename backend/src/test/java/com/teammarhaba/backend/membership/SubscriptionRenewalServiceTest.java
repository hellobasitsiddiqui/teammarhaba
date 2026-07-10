package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
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
import jakarta.persistence.EntityManager;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
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
    private EntityManager entityManager;
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
        entityManager = mock(EntityManager.class); // refresh() is a no-op — race tests stub it explicitly
        // Dunning policy under test: 3 retries, 48h apart.
        service = new SubscriptionRenewalService(
                subscriptions, charges, memberships, users, payments, audit, notifier,
                new SubscriptionProperties(3, 48), entityManager);

        user = mock(User.class);
        when(user.getId()).thenReturn(42L);
        when(user.getFirebaseUid()).thenReturn("uid-42");
        when(users.getById(42L)).thenReturn(user);
        // The tombstone check (TM-623): the default account is active (mock isDeleted() = false).
        when(users.findAnyById(42L)).thenReturn(Optional.of(user));
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

    // ------------------------------------------------------------------ double-charge race (TM-623)

    @Test
    void concurrentRenewalPassChargesExactlyOnce() {
        // Two instances race the same due row. The loser blocks on the user lock while the winner
        // charges + extends + commits. The loser's pre-lock load is a stale L1 snapshot (still due) —
        // the refresh under the lock reveals the committed extension, and the loser must charge NOTHING.
        Subscription subscription = dueActiveSubscription();
        doAnswer(inv -> {
                    // Simulate "the winner committed while we waited": refresh loads the extended row.
                    subscription.extendPeriod(Instant.now());
                    return null;
                })
                .when(entityManager)
                .refresh(subscription);

        boolean acted = service.processOne(7L);

        assertThat(acted).isFalse(); // a clean no-op, not a duplicate charge
        verify(payments, never()).createOrderForCustomer(anyInt(), anyString(), anyString(), anyString());
        verify(payments, never()).payWithSavedMethod(anyString(), anyString());
        verify(charges, never()).save(any());
    }

    // ------------------------------------------------------------------ soft-deleted accounts (TM-623)

    @Test
    void softDeletedAccountIsNeverChargedAndItsSubscriptionLapses() {
        // The renewal engine used to charge FIRST and only then trip over the invisible account —
        // rolling the ledger back and re-charging the card every tick. Now the tombstone check runs
        // BEFORE any provider call: lapse, downgrade the membership, move no money, notify no one.
        Subscription subscription = dueActiveSubscription();
        User deleted = mock(User.class);
        when(deleted.getId()).thenReturn(42L);
        when(deleted.getFirebaseUid()).thenReturn("uid-42");
        when(deleted.isDeleted()).thenReturn(true);
        when(users.findAnyById(42L)).thenReturn(Optional.of(deleted));

        boolean acted = service.processOne(7L);

        assertThat(acted).isTrue();
        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.CANCELED);
        assertThat(subscription.getNextChargeAt()).isNull(); // unscheduled — never scanned again
        verify(payments, never()).createOrderForCustomer(anyInt(), anyString(), anyString(), anyString());
        verify(payments, never()).payWithSavedMethod(anyString(), anyString());
        verify(memberships).applyTierForSubscription(42L, MembershipTier.PAY_PER_EVENT, "uid-42");
        verify(notifier, never()).subscriptionEnded(anyLong(), any(), anyBoolean(), anyString());
    }

    @Test
    void vanishedAccountIsNeverChargedEither() {
        Subscription subscription = dueActiveSubscription();
        when(users.findAnyById(42L)).thenReturn(Optional.empty());

        boolean acted = service.processOne(7L);

        assertThat(acted).isTrue();
        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.CANCELED);
        verify(payments, never()).payWithSavedMethod(anyString(), anyString());
    }

    // ------------------------------------------------------------------ same-window idempotency (TM-623)

    @Test
    void dunningRetryReusesTheWindowsProviderOrderInsteadOfOpeningANewOne() {
        // The previous (ambiguous) attempt for this window already has a provider order. The retry must
        // pay THAT order id again — the gateway rejects paying a completed order, so if the earlier
        // attempt actually settled, the same window cannot be captured twice.
        Subscription subscription = dueActiveSubscription();
        subscription.markPastDue(Instant.now().minus(Duration.ofMinutes(5)), Instant.now());
        Instant windowStart = subscription.getCurrentPeriodEnd();

        SubscriptionCharge previous = new SubscriptionCharge(
                42L, SubscriptionCharge.Kind.RENEWAL, MembershipTier.MONTHLY, 999, Instant.now());
        previous.coverPeriod(windowStart, Subscription.plusOneMonth(windowStart), Instant.now());
        previous.setPaymentReference("revolut", "rev-window-1", "cust-1", Instant.now());
        previous.markFailed(Instant.now());
        when(charges.findFirstByUserIdAndKindAndPeriodStartOrderByIdDesc(
                        42L, SubscriptionCharge.Kind.RENEWAL, windowStart))
                .thenReturn(Optional.of(previous));
        when(payments.payWithSavedMethod("rev-window-1", "pm-1")).thenReturn(new SavedMethodCharge("completed", true));

        service.processOne(7L);

        // No fresh provider order, no fresh ledger row — the window's one charge unit is reused.
        verify(payments, never()).createOrderForCustomer(anyInt(), anyString(), anyString(), anyString());
        verify(charges, never()).save(any());
        assertThat(previous.getStatus()).isEqualTo(SubscriptionCharge.Status.PAID);
        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.ACTIVE);
    }

    @Test
    void windowAlreadyPaidExtendsWithoutCharging() {
        // A late webhook healed the window's charge between the scan and the lock: the money for this
        // window already moved — grant the time, charge absolutely nothing.
        Subscription subscription = dueActiveSubscription();
        Instant windowStart = subscription.getCurrentPeriodEnd();

        SubscriptionCharge paid = new SubscriptionCharge(
                42L, SubscriptionCharge.Kind.RENEWAL, MembershipTier.MONTHLY, 999, Instant.now());
        paid.coverPeriod(windowStart, Subscription.plusOneMonth(windowStart), Instant.now());
        paid.markPaid(windowStart, Subscription.plusOneMonth(windowStart), Instant.now());
        when(charges.findFirstByUserIdAndKindAndPeriodStartOrderByIdDesc(
                        42L, SubscriptionCharge.Kind.RENEWAL, windowStart))
                .thenReturn(Optional.of(paid));

        service.processOne(7L);

        assertThat(subscription.getCurrentPeriodStart()).isEqualTo(windowStart);
        verify(payments, never()).createOrderForCustomer(anyInt(), anyString(), anyString(), anyString());
        verify(payments, never()).payWithSavedMethod(anyString(), anyString());
    }

    // ------------------------------------------------------------------ indeterminate outcomes (TM-623)

    @Test
    void indeterminateProviderStateKeepsTheChargePendingAndSchedulesARecheck() {
        // "pending"/"processing" is NOT a decline: the money may still be captured for THIS attempt.
        // The charge must stay PENDING (the webhook is the authority) and the user must NOT get a
        // false "payment problem" nudge; the scheduled re-check hits the same provider order.
        Subscription subscription = dueActiveSubscription();
        when(payments.createOrderForCustomer(anyInt(), anyString(), anyString(), anyString()))
                .thenReturn(new PaymentOrder("rev-ren-7", "tok"));
        when(payments.payWithSavedMethod("rev-ren-7", "pm-1")).thenReturn(SavedMethodCharge.fromState("processing"));

        service.processOne(7L);

        ArgumentCaptor<SubscriptionCharge> saved = ArgumentCaptor.forClass(SubscriptionCharge.class);
        verify(charges).save(saved.capture());
        assertThat(saved.getValue().getStatus()).isEqualTo(SubscriptionCharge.Status.PENDING);
        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.PAST_DUE); // re-check scheduled
        verify(notifier, never()).renewalFailed(anyLong(), any(), anyString());
    }

    // ------------------------------------------------------------------ catch-up policy (TM-623)

    @Test
    void multiMonthArrearsChargesOnceReanchoredAtNowInsteadOfStacking() {
        // The scheduler was down for months. Charging window-by-window would stack one back-charge per
        // missed month, minutes apart. Policy: ONE charge, window re-anchored at now, gap forgiven.
        Instant subscribed = Instant.now().minus(Duration.ofDays(150)); // ~5 months ago
        Subscription subscription = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", subscribed);
        subscription.savePaymentMethodRef("pm-1", subscribed);
        when(subscriptions.findById(7L)).thenReturn(Optional.of(subscription));
        when(payments.createOrderForCustomer(anyInt(), anyString(), anyString(), anyString()))
                .thenReturn(new PaymentOrder("rev-catchup", "tok"));
        when(payments.payWithSavedMethod("rev-catchup", "pm-1")).thenReturn(new SavedMethodCharge("completed", true));

        Instant before = Instant.now();
        service.processOne(7L);

        // One charge; the new window starts ~now (re-anchored), not at the months-old period end.
        verify(payments).payWithSavedMethod("rev-catchup", "pm-1");
        assertThat(subscription.getCurrentPeriodStart()).isBetween(before, Instant.now());
        assertThat(subscription.getCurrentPeriodEnd())
                .isEqualTo(Subscription.plusOneMonth(subscription.getCurrentPeriodStart()));
        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.ACTIVE);
        // The row is no longer due — the very next tick performs NO second catch-up charge.
        assertThat(subscription.getNextChargeAt()).isAfter(Instant.now());
    }

    // ------------------------------------------------------------------ catch-up retry idempotency (TM-625)

    @Test
    void arrearsCatchupWithIndeterminateFirstAttemptChargesExactlyOnce() {
        // The CatchUpDoubleChargeRepro scenario (TM-625). A subscription >1 full cycle in arrears (the
        // kill-switch re-enable state) hits the catch-up branch, whose window is re-anchored at "now"
        // on EVERY attempt. Attempt 1 is indeterminate ("processing" — the money may STILL capture);
        // the dunning retry then falls due with the settle webhook still unheard. Because the retry
        // re-anchors periodStart afresh, the exact-window idempotency lookup can never find attempt 1
        // — before the fix, the retry opened AND paid a SECOND provider order while the first could
        // also settle: the card charged twice for the same effective month. The fix's invariant: ONE
        // provider order for the whole episode, the retry re-paying it gateway-idempotently.
        Instant subscribed = Instant.now().minus(Duration.ofDays(150)); // ~5 months in arrears
        Subscription subscription = new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", subscribed);
        subscription.savePaymentMethodRef("pm-1", subscribed);
        when(subscriptions.findById(7L)).thenReturn(Optional.of(subscription));

        // A DB-faithful in-memory ledger implementing the repository contracts the service uses: the
        // window lookup matches on EXACT periodStart equality (what the real derived query does — the
        // very semantics the re-anchor defeats), and the open-attempt fallback scans status + presence
        // of a provider order id. Mocking the finders loosely would hide the bug the test exists for.
        List<SubscriptionCharge> ledger = new ArrayList<>();
        when(charges.save(any(SubscriptionCharge.class))).thenAnswer(inv -> {
            ledger.add(inv.getArgument(0));
            return inv.getArgument(0);
        });
        when(charges.findFirstByUserIdAndKindAndPeriodStartOrderByIdDesc(
                        eq(42L), eq(SubscriptionCharge.Kind.RENEWAL), any(Instant.class)))
                .thenAnswer(inv -> {
                    Instant windowStart = inv.getArgument(2);
                    return ledger.stream()
                            .filter(c -> windowStart.equals(c.getPeriodStart()))
                            .reduce((first, second) -> second); // newest wins, like ORDER BY id DESC
                });
        when(charges.findFirstByUserIdAndKindAndStatusInAndProviderOrderIdIsNotNullOrderByIdDesc(
                        eq(42L), eq(SubscriptionCharge.Kind.RENEWAL), any()))
                .thenAnswer(inv -> {
                    Collection<SubscriptionCharge.Status> statuses = inv.getArgument(2);
                    return ledger.stream()
                            .filter(c -> statuses.contains(c.getStatus()) && c.getProviderOrderId() != null)
                            .reduce((first, second) -> second);
                });

        when(payments.createOrderForCustomer(anyInt(), anyString(), anyString(), anyString()))
                .thenReturn(new PaymentOrder("rev-o1", "tok"));
        // Attempt 1: indeterminate — the charge stays PENDING (the webhook is the authority) and the
        // subscription enters the dunning re-check schedule.
        when(payments.payWithSavedMethod("rev-o1", "pm-1")).thenReturn(SavedMethodCharge.fromState("processing"));

        service.processOne(7L);

        assertThat(ledger).hasSize(1);
        assertThat(ledger.get(0).getStatus()).isEqualTo(SubscriptionCharge.Status.PENDING);
        assertThat(ledger.get(0).getProviderOrderId()).isEqualTo("rev-o1");

        // The 48h retry falls due with the settle webhook STILL unheard — the double-charge window.
        subscription.markPastDue(Instant.now().minus(Duration.ofMinutes(5)), Instant.now());

        // Attempt 2 (the retry): must re-pay the SAME provider order; this time it settles.
        when(payments.payWithSavedMethod("rev-o1", "pm-1")).thenReturn(new SavedMethodCharge("completed", true));

        service.processOne(7L);

        // EXACTLY ONE provider order was ever opened — the retry reused attempt 1's charge unit
        // (before the fix: createOrderForCustomer twice, a second order paid, two possible captures).
        verify(payments, times(1)).createOrderForCustomer(anyInt(), anyString(), anyString(), anyString());
        verify(payments, times(2)).payWithSavedMethod("rev-o1", "pm-1");
        assertThat(ledger).hasSize(1); // one charge unit for the whole episode, reused not duplicated
        assertThat(ledger.get(0).getStatus()).isEqualTo(SubscriptionCharge.Status.PAID);
        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.ACTIVE);
        assertThat(subscription.getNextChargeAt()).isAfter(Instant.now()); // no longer due
    }
}
