package com.teammarhaba.backend.membership;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.config.SubscriptionProperties;
import com.teammarhaba.backend.payments.PaymentOrder;
import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.payments.PaymentProviderException;
import com.teammarhaba.backend.payments.SavedMethodCharge;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The renewal + dunning engine (TM-620): charges due subscriptions off-session each cycle and applies
 * the failure policy. Driven by {@link SubscriptionRenewalScheduler}'s fixed-delay tick; all the logic
 * lives here so tests exercise it directly and deterministically (the same split as
 * {@code EventReminderScheduler} / {@code EventReminderService}).
 *
 * <p><strong>What "due" means.</strong> A subscription's {@code nextChargeAt} is the single pointer for
 * whatever the scheduler owes it next (see {@link Subscription}): an ACTIVE row due its monthly renewal,
 * a PAST_DUE row due a dunning retry, or a user-CANCELED row whose paid period just ran out — due its
 * downgrade to pay-per-event.
 *
 * <p><strong>Renewal charge (MIT).</strong> A due ACTIVE/PAST_DUE row is charged through the
 * {@link PaymentProvider} seam: create an order against the stored provider customer, then pay it with
 * the saved payment method, {@code initiator=merchant} — an off-session merchant-initiated transaction,
 * SCA-exempt because the mandate was authenticated on the first in-browser payment. Success rolls the
 * paid window forward one month from the previous period END (anniversary billing); the settle webhook
 * that follows is an idempotent no-op ({@code SubscriptionService.confirmCharge} finds the charge PAID).
 *
 * <p><strong>Dunning.</strong> A failed charge marks the row PAST_DUE and schedules a retry
 * ({@link SubscriptionProperties#retryInterval()} apart, {@link SubscriptionProperties#maxRetries()}
 * times) — the tier is KEPT while retries last, and the user is nudged to fix their card. Exhausting
 * the retries lapses the subscription and downgrades the membership to pay-per-event, with a
 * notification. Every attempt is a {@link SubscriptionCharge} ledger row, so admin history and webhook
 * healing both have the full picture.
 *
 * <p><strong>Concurrency.</strong> Each subscription is processed in its OWN transaction (the scheduler
 * loops, so one poisoned row can't fail the pass), under the account's user-row lock (the TM-423
 * convention) so a renewal can never race a webhook confirm or a re-subscribe on the same account; the
 * {@code @Version} column backstops anything the lock doesn't cover. Any number of instances may tick —
 * a second instance's write on the same row loses the optimistic lock and retries next tick.
 */
@Service
public class SubscriptionRenewalService {

    private static final Logger log = LoggerFactory.getLogger(SubscriptionRenewalService.class);

    /** The single currency subscriptions charge in — prices are defined in GBP pence (V38). */
    private static final String CURRENCY = "GBP";

    private final SubscriptionRepository subscriptions;
    private final SubscriptionChargeRepository charges;
    private final MembershipService memberships;
    private final UserService users;
    private final PaymentProvider payments;
    private final AuditService audit;
    private final SubscriptionNotifier notifier;
    private final SubscriptionProperties props;

    public SubscriptionRenewalService(
            SubscriptionRepository subscriptions,
            SubscriptionChargeRepository charges,
            MembershipService memberships,
            UserService users,
            PaymentProvider payments,
            AuditService audit,
            SubscriptionNotifier notifier,
            SubscriptionProperties props) {
        this.subscriptions = subscriptions;
        this.charges = charges;
        this.memberships = memberships;
        this.users = users;
        this.payments = payments;
        this.audit = audit;
        this.notifier = notifier;
        this.props = props;
    }

    /**
     * The subscriptions the scheduler owes an action right now (oldest-due first, bounded — see the
     * repository). Ids only: the scheduler feeds each to {@link #processOne} in its own transaction.
     */
    @Transactional(readOnly = true)
    public List<Long> findDueSubscriptionIds() {
        return subscriptions.findTop100ByNextChargeAtLessThanEqualOrderByNextChargeAtAsc(Instant.now()).stream()
                .map(Subscription::getId)
                .toList();
    }

    /**
     * Process one due subscription — renewal charge, dunning retry, or end-of-period downgrade — in its
     * own transaction under the account's user-row lock. Re-checks due-ness under the lock, so a row
     * another instance (or a webhook) just handled becomes a no-op.
     *
     * @return {@code true} when an action was performed, {@code false} for a no-longer-due no-op
     */
    @Transactional
    public boolean processOne(Long subscriptionId) {
        Instant now = Instant.now();
        Subscription subscription = subscriptions.findById(subscriptionId).orElse(null);
        if (subscription == null || !isDue(subscription, now)) {
            return false;
        }
        // Serialise with webhook confirms / subscribes / other instances on this account, then re-check:
        // whoever held the lock before us may have already renewed or reset the row.
        users.lockForUpdate(subscription.getUserId());
        if (!isDue(subscription, now)) {
            return false;
        }

        if (subscription.getStatus() == SubscriptionStatus.CANCELED) {
            // A user-cancelled subscription whose paid period just ran out: the promised downgrade.
            endSubscription(subscription, now, false);
            return true;
        }
        attemptRenewal(subscription, now);
        return true;
    }

    /** Whether the scheduler owes this row an action at {@code now} (its "due" pointer has passed). */
    private static boolean isDue(Subscription subscription, Instant now) {
        return subscription.getNextChargeAt() != null && !subscription.getNextChargeAt().isAfter(now);
    }

    /**
     * Charge a due ACTIVE/PAST_DUE subscription off-session and apply the outcome: extend on success,
     * dunning (or the terminal downgrade) on failure. Provider exceptions are caught and treated as a
     * failed attempt — a gateway outage must enter dunning, not roll back the bookkeeping.
     */
    private void attemptRenewal(Subscription subscription, Instant now) {
        int amountPence = SubscriptionPricing.monthlyPricePence(subscription.getTier());

        // The window this renewal buys: one month rolled forward from the CURRENT period end — the
        // anniversary anchor — regardless of how late dunning made the actual charge.
        Instant periodStart = subscription.getCurrentPeriodEnd();
        Instant periodEnd = Subscription.plusOneMonth(periodStart);

        // Resolve the saved card: the stored ref, else re-fetch the customer's merchant-saved method
        // (e.g. the activation-time fetch failed). Still nothing ⇒ a failed attempt (dunning), not an error.
        String paymentMethodRef = subscription.getSavedPaymentMethodRef();
        if (paymentMethodRef == null && subscription.getProviderCustomerId() != null) {
            try {
                paymentMethodRef = payments.findMerchantSavedPaymentMethod(subscription.getProviderCustomerId())
                        .orElse(null);
                if (paymentMethodRef != null) {
                    subscription.savePaymentMethodRef(paymentMethodRef, now);
                }
            } catch (PaymentProviderException e) {
                log.warn("Could not list saved payment methods for user {}", subscription.getUserId(), e);
            }
        }

        // Ledger row first (its id is the merchant reference), stamped with the window it is buying so
        // a late webhook can heal it even if the synchronous outcome below is a failure.
        SubscriptionCharge charge = charges.save(new SubscriptionCharge(
                subscription.getUserId(), SubscriptionCharge.Kind.RENEWAL, subscription.getTier(),
                amountPence, now));
        charge.coverPeriod(periodStart, periodEnd, now);

        boolean settled = false;
        String failureDetail = "no saved payment method";
        if (paymentMethodRef != null) {
            try {
                PaymentOrder order = payments.createOrderForCustomer(
                        amountPence, CURRENCY, "sub-charge:" + charge.getId(), subscription.getProviderCustomerId());
                charge.setPaymentReference(
                        payments.name(), order.id(), subscription.getProviderCustomerId(), now);
                SavedMethodCharge result = payments.payWithSavedMethod(order.id(), paymentMethodRef);
                settled = result.settled();
                failureDetail = settled ? null : "provider state: " + result.state();
            } catch (PaymentProviderException e) {
                log.warn("Renewal charge failed for user {}", subscription.getUserId(), e);
                failureDetail = "provider error";
            }
        }

        User user = users.getById(subscription.getUserId());
        if (settled) {
            charge.markPaid(periodStart, periodEnd, now);
            subscription.extendPeriod(now);
            audit.record(
                    user.getFirebaseUid(),
                    AuditAction.SUBSCRIPTION_RENEWED,
                    SubscriptionService.TARGET_SUBSCRIPTION,
                    String.valueOf(user.getId()),
                    Map.of(
                            "tier", subscription.getTier().name(),
                            "periodEnd", subscription.getCurrentPeriodEnd().toString()));
            notifier.renewalSucceeded(
                    user.getId(),
                    subscription.getTier(),
                    "subscription:" + user.getId() + ":renewed:" + subscription.getCurrentPeriodEnd());
            return;
        }

        charge.markFailed(now);
        if (subscription.getRetryCount() < props.maxRetries()) {
            // Dunning: keep the tier, schedule the next retry, nudge the user to check their card.
            subscription.markPastDue(now.plus(props.retryInterval()), now);
            audit.record(
                    user.getFirebaseUid(),
                    AuditAction.SUBSCRIPTION_RENEWAL_FAILED,
                    SubscriptionService.TARGET_SUBSCRIPTION,
                    String.valueOf(user.getId()),
                    Map.of(
                            "tier", subscription.getTier().name(),
                            "retryCount", String.valueOf(subscription.getRetryCount()),
                            "detail", failureDetail == null ? "" : failureDetail));
            notifier.renewalFailed(
                    user.getId(),
                    subscription.getTier(),
                    "subscription:" + user.getId() + ":dunning:" + subscription.getRetryCount());
            return;
        }

        // Dunning exhausted: the grace window is spent — lapse and downgrade to pay-per-event.
        endSubscription(subscription, now, true);
    }

    /**
     * Terminal end (TM-620): lapse the subscription (nothing pending any more), downgrade the membership
     * to pay-per-event through the ungated subscription path, audit and notify. Shared by the
     * dunning-exhausted path and the user-cancel-reached-period-end path — only the copy/reason differ.
     */
    private void endSubscription(Subscription subscription, Instant now, boolean dunningExhausted) {
        MembershipTier endedTier = subscription.getTier();
        subscription.lapse(now);

        User user = users.getById(subscription.getUserId());
        memberships.applyTierForSubscription(user.getId(), MembershipTier.PAY_PER_EVENT, user.getFirebaseUid());
        audit.record(
                user.getFirebaseUid(),
                AuditAction.SUBSCRIPTION_LAPSED,
                SubscriptionService.TARGET_SUBSCRIPTION,
                String.valueOf(user.getId()),
                Map.of(
                        "tier", endedTier.name(),
                        "reason", dunningExhausted ? "dunning_exhausted" : "period_ended"));
        notifier.subscriptionEnded(
                user.getId(),
                endedTier,
                dunningExhausted,
                "subscription:" + user.getId() + ":ended:" + subscription.getCurrentPeriodEnd());
    }
}
