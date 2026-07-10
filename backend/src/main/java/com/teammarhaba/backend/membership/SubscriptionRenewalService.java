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
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityNotFoundException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
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
 * notification. Every billing window is a {@link SubscriptionCharge} ledger row, so admin history and
 * webhook healing both have the full picture.
 *
 * <p><strong>Money-safety invariants (TM-623)</strong> — a provider charge is an external, irreversible
 * side effect that no local rollback can undo, so every decision to charge is made on committed state:
 *
 * <ul>
 *   <li><b>Fresh read under the lock.</b> {@link #processOne} loads the subscription, takes the
 *       account's user-row lock, then {@code EntityManager.refresh}es the subscription — a repository
 *       re-query would return the SAME stale first-level-cache instance, so whatever another instance
 *       or a webhook committed while we waited (a renewal, a heal, a re-subscribe reset) would be
 *       invisible and the card would be charged a second time for the same cycle.</li>
 *   <li><b>One charge unit per (subscription, window).</b> A dunning retry re-uses the previous
 *       attempt's ledger row AND its provider order — paying the same order id again is rejected
 *       gateway-side if the earlier attempt actually settled (a timeout is ambiguous!), so the same
 *       billing window can never be captured twice.</li>
 *   <li><b>Tombstoned accounts are never charged.</b> The due scan excludes soft-deleted users, and
 *       {@link #processOne} re-checks the account (restriction-bypassing read) BEFORE any provider
 *       call: a deleted account's subscription lapses charge-free instead of the old behaviour —
 *       charge first, blow up on the invisible account, roll the ledger back, retry the charge every
 *       tick, forever.</li>
 *   <li><b>Indeterminate provider states stay open.</b> A {@code pending}/{@code processing} pay-order
 *       response is NOT a terminal failure: the charge stays PENDING (the settle webhook is the
 *       authority) and the re-check later hits the same provider order — never a fresh charge.</li>
 *   <li><b>Catch-up is forgiven, not stacked.</b> A subscription more than one full cycle in arrears
 *       (scheduler outage, kill-switch window) is charged ONCE for a window re-anchored at now —
 *       instead of one back-charge per missed month, 5 minutes apart, tripping issuer fraud rules.</li>
 * </ul>
 *
 * <p><strong>Concurrency.</strong> Each subscription is processed in its OWN transaction (the scheduler
 * loops, so one poisoned row can't fail the pass), under the account's user-row lock (the TM-423
 * convention) so a renewal can never race a webhook confirm or a re-subscribe on the same account; the
 * refresh-under-lock above makes the due re-check real, and the {@code @Version} column backstops the
 * local bookkeeping. Any number of instances may tick.
 */
@Service
public class SubscriptionRenewalService {

    private static final Logger log = LoggerFactory.getLogger(SubscriptionRenewalService.class);

    /** The single currency subscriptions charge in — prices are defined in GBP pence (V38). */
    private static final String CURRENCY = "GBP";

    /** Upper bound on subscriptions handled per pass (oldest-due first; the next tick takes the rest). */
    private static final int SCAN_LIMIT = 100;

    private final SubscriptionRepository subscriptions;
    private final SubscriptionChargeRepository charges;
    private final MembershipService memberships;
    private final UserService users;
    private final PaymentProvider payments;
    private final AuditService audit;
    private final SubscriptionNotifier notifier;
    private final SubscriptionProperties props;
    private final EntityManager entityManager;

    public SubscriptionRenewalService(
            SubscriptionRepository subscriptions,
            SubscriptionChargeRepository charges,
            MembershipService memberships,
            UserService users,
            PaymentProvider payments,
            AuditService audit,
            SubscriptionNotifier notifier,
            SubscriptionProperties props,
            EntityManager entityManager) {
        this.subscriptions = subscriptions;
        this.charges = charges;
        this.memberships = memberships;
        this.users = users;
        this.payments = payments;
        this.audit = audit;
        this.notifier = notifier;
        this.props = props;
        this.entityManager = entityManager;
    }

    /**
     * The subscriptions the scheduler owes an action right now (oldest-due first, bounded; soft-deleted
     * accounts' rows are excluded at the query — they must never be charged). Ids only: the scheduler
     * feeds each to {@link #processOne} in its own transaction.
     */
    @Transactional(readOnly = true)
    public List<Long> findDueSubscriptionIds() {
        return subscriptions.findDueForActiveUsers(Instant.now(), PageRequest.of(0, SCAN_LIMIT)).stream()
                .map(Subscription::getId)
                .toList();
    }

    /**
     * Process one due subscription — renewal charge, dunning retry, or end-of-period downgrade — in its
     * own transaction under the account's user-row lock. The subscription is re-read fresh (refresh)
     * under the lock, so a row another instance (or a webhook) just handled becomes a no-op instead of
     * a duplicate charge.
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
        // Serialise with webhook confirms / subscribes / other instances on this account…
        users.lockForUpdate(subscription.getUserId());
        // …then RE-READ COMMITTED STATE (TM-623). The pre-lock load is a stale L1-cache snapshot: a
        // repository re-query would hand back the same instance with its old field values, so whoever
        // held the lock before us (another instance's tick, a webhook heal) would be invisible and we
        // would charge the card again for a cycle that is already paid. refresh() forces the SELECT.
        try {
            entityManager.refresh(subscription);
        } catch (EntityNotFoundException gone) {
            return false; // row deleted while we waited for the lock — nothing to do
        }
        if (!isDue(subscription, now)) {
            return false; // whoever held the lock before us already renewed or reset the row
        }

        // Resolve the account BEFORE any provider call (TM-623): a soft-deleted account must never be
        // charged. The restriction-bypassing read tells "tombstoned" apart from "gone entirely" — both
        // are terminal for the subscription, and neither may move money.
        User account = users.findAnyById(subscription.getUserId()).orElse(null);
        if (account == null || account.isDeleted()) {
            endForDeletedAccount(subscription, account, now);
            return true;
        }

        if (subscription.getStatus() == SubscriptionStatus.CANCELED) {
            // A user-cancelled subscription whose paid period just ran out: the promised downgrade.
            endSubscription(subscription, account, now, false);
            return true;
        }
        attemptRenewal(subscription, account, now);
        return true;
    }

    /** Whether the scheduler owes this row an action at {@code now} (its "due" pointer has passed). */
    private static boolean isDue(Subscription subscription, Instant now) {
        return subscription.getNextChargeAt() != null && !subscription.getNextChargeAt().isAfter(now);
    }

    /**
     * Charge a due ACTIVE/PAST_DUE subscription off-session and apply the outcome: extend on success,
     * dunning (or the terminal downgrade) on definitive failure, keep-PENDING-and-recheck on an
     * indeterminate provider state. Provider exceptions are caught and treated as a failed attempt — a
     * gateway outage must enter dunning, not roll back the bookkeeping.
     */
    private void attemptRenewal(Subscription subscription, User user, Instant now) {
        int amountPence = SubscriptionPricing.monthlyPricePence(subscription.getTier());

        // The window this renewal buys: one month rolled forward from the CURRENT period end — the
        // anniversary anchor — regardless of how late dunning made the actual charge.
        Instant periodStart = subscription.getCurrentPeriodEnd();
        Instant periodEnd = Subscription.plusOneMonth(periodStart);

        // Catch-up policy (TM-623): more than one FULL cycle in arrears (scheduler outage, kill-switch
        // window, wedged row) means charging window-by-window would stack k identical charges minutes
        // apart — and every one of those windows is already in the past, buying the user nothing.
        // Charge ONCE for a window re-anchored at now: the gap is forgiven, the anniversary moves to
        // today. (Condition: even the window this charge would buy has fully elapsed.)
        if (periodEnd.isBefore(now)) {
            log.warn(
                    "Subscription {} is more than one full cycle in arrears; re-anchoring at now and "
                            + "charging once instead of stacking back-charges (TM-623).",
                    subscription.getId());
            periodStart = now;
            periodEnd = Subscription.plusOneMonth(now);
        }

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

        // ONE ledger row per (account, window) — the idempotency unit (TM-623). A dunning retry re-uses
        // the earlier attempt's row and, crucially, its provider order: paying the same order id again
        // is rejected gateway-side if the previous ambiguous attempt actually settled, so this window
        // can never be captured twice. Only a window never attempted before gets a fresh row.
        SubscriptionCharge charge = charges.findFirstByUserIdAndKindAndPeriodStartOrderByIdDesc(
                        subscription.getUserId(), SubscriptionCharge.Kind.RENEWAL, periodStart)
                .orElse(null);
        if (charge == null) {
            charge = charges.save(new SubscriptionCharge(
                    subscription.getUserId(), SubscriptionCharge.Kind.RENEWAL, subscription.getTier(),
                    amountPence, now));
            charge.coverPeriod(periodStart, periodEnd, now);
        } else if (charge.getStatus() == SubscriptionCharge.Status.PAID) {
            // The window is already paid (a late webhook healed the charge between the scan and here,
            // without extending — e.g. it raced this pass). Grant the paid time; charge NOTHING.
            subscription.extendPeriodTo(periodStart, periodEnd, now);
            log.info(
                    "Subscription {} window starting {} was already PAID (charge {}); extended without charging.",
                    subscription.getId(),
                    periodStart,
                    charge.getId());
            return;
        }

        boolean settled = false;
        boolean indeterminate = false;
        String failureDetail = "no saved payment method";
        if (paymentMethodRef != null) {
            try {
                // Re-use the window's existing provider order (the retry path); open one only for a
                // first attempt. The order id is the gateway-side idempotency reference for the window.
                String providerOrderId = charge.getProviderOrderId();
                if (providerOrderId == null) {
                    PaymentOrder order = payments.createOrderForCustomer(
                            amountPence,
                            CURRENCY,
                            "sub-charge:" + charge.getId(),
                            subscription.getProviderCustomerId());
                    charge.setPaymentReference(
                            payments.name(), order.id(), subscription.getProviderCustomerId(), now);
                    providerOrderId = order.id();
                }
                SavedMethodCharge result = payments.payWithSavedMethod(providerOrderId, paymentMethodRef);
                settled = result.settled();
                indeterminate = result.indeterminate();
                failureDetail = settled ? null : "provider state: " + result.state();
            } catch (PaymentProviderException e) {
                log.warn("Renewal charge failed for user {}", subscription.getUserId(), e);
                failureDetail = "provider error";
            }
        }

        if (settled) {
            charge.markPaid(periodStart, periodEnd, now);
            subscription.extendPeriodTo(periodStart, periodEnd, now);
            audit.record(
                    user.getFirebaseUid(),
                    AuditAction.SUBSCRIPTION_RENEWED,
                    SubscriptionService.TARGET_SUBSCRIPTION,
                    String.valueOf(user.getId()),
                    Map.of(
                            "tier", subscription.getTier().name(),
                            "periodEnd", subscription.getCurrentPeriodEnd().toString()));
            // Charge-id sourceRef (TM-623): stable across this sync path AND the webhook heal, so a
            // racing duplicate can never produce a second "renewed" inbox row for the same charge.
            notifier.renewalSucceeded(
                    user.getId(),
                    subscription.getTier(),
                    "subscription-charge:" + charge.getId() + ":renewed");
            return;
        }

        // An indeterminate outcome (pending/processing — the money may STILL be captured) keeps the
        // charge PENDING: the settle webhook is the authority, and the scheduled re-check below hits
        // the SAME provider order. Only a definitive decline is a FAILED ledger entry.
        if (!indeterminate) {
            charge.markFailed(now);
        }
        if (subscription.getRetryCount() < props.maxRetries()) {
            // Dunning: keep the tier, schedule the next attempt/re-check.
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
            if (!indeterminate) {
                // Nudge the user to fix their card — but not for an in-flight payment that may yet
                // settle on its own (a "payment problem" alert there would be false).
                notifier.renewalFailed(
                        user.getId(),
                        subscription.getTier(),
                        "subscription:" + user.getId() + ":dunning:" + subscription.getRetryCount());
            }
            return;
        }

        // Dunning exhausted: the grace window is spent — lapse and downgrade to pay-per-event.
        endSubscription(subscription, user, now, true);
    }

    /**
     * Terminal end (TM-620): lapse the subscription (nothing pending any more), downgrade the membership
     * to pay-per-event through the ungated subscription path, audit and notify. Shared by the
     * dunning-exhausted path and the user-cancel-reached-period-end path — only the copy/reason differ.
     */
    private void endSubscription(Subscription subscription, User user, Instant now, boolean dunningExhausted) {
        MembershipTier endedTier = subscription.getTier();
        subscription.lapse(now);

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

    /**
     * Terminal end for a tombstoned (or vanished) account (TM-623): lapse the subscription and downgrade
     * the membership WITHOUT any charge, notification or retry loop. Belt-and-braces — the soft-delete
     * path itself lapses the subscription now, so this mainly covers rows tombstoned before that fix
     * (or an account deleted between the scan and the lock). No inbox/push notification: there is no
     * one to notify.
     */
    private void endForDeletedAccount(Subscription subscription, User account, Instant now) {
        MembershipTier endedTier = subscription.getTier();
        subscription.lapse(now);
        if (account != null) {
            // The tombstoned row still carries the uid — downgrade the membership and leave an audit
            // trail so a later account restore doesn't resurrect a paid tier with no subscription.
            memberships.applyTierForSubscription(
                    account.getId(), MembershipTier.PAY_PER_EVENT, account.getFirebaseUid());
            audit.record(
                    account.getFirebaseUid(),
                    AuditAction.SUBSCRIPTION_LAPSED,
                    SubscriptionService.TARGET_SUBSCRIPTION,
                    String.valueOf(account.getId()),
                    Map.of("tier", endedTier.name(), "reason", "account_deleted"));
        }
        log.warn(
                "Subscription {} lapsed without charging: account {} is deleted/missing (TM-623).",
                subscription.getId(),
                subscription.getUserId());
    }
}
