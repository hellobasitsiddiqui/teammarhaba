package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.Test;

/**
 * Entity-level state-machine coverage of {@link Subscription} (TM-629 test backfill) — the invariants
 * the review findings showed can silently rot inside service-level flows:
 *
 * <ul>
 *   <li><b>No contradictory ACTIVE-with-canceledAt state</b> (finding #20): a webhook heal extending a
 *       CANCELED row keeps it CANCELED with its cancel timestamp; only the PAST_DUE→ACTIVE return and
 *       a full (re)activation may end up ACTIVE, and then always with {@code canceledAt == null}.</li>
 *   <li><b>Residual paid time is credited on re-subscribe</b> (findings #12/#19): re-activating a
 *       CANCELED row whose paid window still has time left extends the fresh period by exactly the
 *       unexpired remainder instead of swallowing it.</li>
 * </ul>
 */
class SubscriptionTest {

    private static Subscription activeSubscription(Instant subscribedAt) {
        return new Subscription(42L, MembershipTier.MONTHLY, "revolut", "cust-1", subscribedAt);
    }

    // ------------------------------------------------------------------ finding #20: canceledAt hygiene

    @Test
    void extendPeriodToOnACanceledRowStaysCanceledAndKeepsItsCancelTimestamp() {
        // The healRenewal path: money settled late for a subscription the user has since cancelled.
        // The paid window is granted, but the row must NOT come back ACTIVE (that would re-arm
        // auto-renewal against a withdrawn mandate) — and because it stays CANCELED, canceledAt being
        // set stays CONSISTENT. The original finding: an ACTIVE row wearing a canceledAt timestamp,
        // which the admin view rendered as contradictory state.
        Instant subscribed = Instant.now().minus(Duration.ofDays(40));
        Subscription subscription = activeSubscription(subscribed);
        Instant cancelTime = Instant.now().minus(Duration.ofDays(2));
        subscription.cancelAtPeriodEnd(cancelTime);

        Instant newStart = subscription.getCurrentPeriodEnd();
        Instant newEnd = Subscription.plusOneMonth(newStart);
        subscription.extendPeriodTo(newStart, newEnd, Instant.now());

        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.CANCELED);
        assertThat(subscription.getCanceledAt()).isEqualTo(cancelTime); // kept — consistent with CANCELED
        assertThat(subscription.getCurrentPeriodEnd()).isEqualTo(newEnd); // the paid time IS granted
        // The "due" pointer parked at the new period end is the DOWNGRADE pass, not a renewal charge.
        assertThat(subscription.getNextChargeAt()).isEqualTo(newEnd);
    }

    @Test
    void extendPeriodToOnAPastDueRowReturnsToActiveWithNoCancelTimestamp() {
        // The dunning-recovery path: a successful (or healed) charge on a PAST_DUE row returns it to a
        // clean ACTIVE state — and an ACTIVE row must never carry a canceledAt (finding #20's
        // contradictory-state invariant, asserted from the other side).
        Instant subscribed = Instant.now().minus(Duration.ofDays(35));
        Subscription subscription = activeSubscription(subscribed);
        subscription.markPastDue(Instant.now().plus(Duration.ofHours(48)), Instant.now());

        Instant newStart = subscription.getCurrentPeriodEnd();
        Instant newEnd = Subscription.plusOneMonth(newStart);
        subscription.extendPeriodTo(newStart, newEnd, Instant.now());

        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.ACTIVE);
        assertThat(subscription.getCanceledAt()).isNull();
        assertThat(subscription.getRetryCount()).isZero(); // the dunning episode is over
    }

    @Test
    void activateClearsTheCancelTimestampOnAResubscribe() {
        // A full re-activation IS a fresh consent: the row returns ACTIVE and the old cancel timestamp
        // must be gone — the one legitimate CANCELED→ACTIVE transition.
        Instant subscribed = Instant.now().minus(Duration.ofDays(60));
        Subscription subscription = activeSubscription(subscribed);
        subscription.cancelAtPeriodEnd(subscribed.plus(Duration.ofDays(3)));

        subscription.activate(MembershipTier.DIAMOND, "revolut", "cust-2", Instant.now());

        assertThat(subscription.getStatus()).isEqualTo(SubscriptionStatus.ACTIVE);
        assertThat(subscription.getCanceledAt()).isNull();
        assertThat(subscription.getTier()).isEqualTo(MembershipTier.DIAMOND);
        assertThat(subscription.getSavedPaymentMethodRef()).isNull(); // re-resolved from the provider
    }

    // ------------------------------------------------------------------ findings #12/#19: residual credit

    @Test
    void activateOnACanceledRowWithPaidTimeLeftCreditsTheUnexpiredRemainder() {
        // Cancel day 1, re-subscribe day 2: the old window still has ~29 paid days. Pre-fix, activate()
        // reset the period to exactly one month from now — the residual days simply vanished and the
        // customer paid twice for the overlap. They must be carried into the fresh period.
        Instant subscribed = Instant.now().minus(Duration.ofDays(1));
        Subscription subscription = activeSubscription(subscribed);
        subscription.cancelAtPeriodEnd(Instant.now());
        Instant oldPaidUntil = subscription.getCurrentPeriodEnd();
        assertThat(oldPaidUntil).isAfter(Instant.now()); // the precondition: paid time remains

        Instant reactivation = Instant.now();
        subscription.activate(MembershipTier.MONTHLY, "revolut", "cust-1", reactivation);

        Duration remainder = Duration.between(reactivation, oldPaidUntil);
        assertThat(subscription.getCurrentPeriodStart()).isEqualTo(reactivation);
        assertThat(subscription.getCurrentPeriodEnd())
                .isEqualTo(Subscription.plusOneMonth(reactivation).plus(remainder));
        assertThat(subscription.getNextChargeAt()).isEqualTo(subscription.getCurrentPeriodEnd());
    }

    @Test
    void activateOnAnExpiredCanceledRowStartsAPlainFreshMonth() {
        // Nothing left to credit once the paid window has run out — the fresh period is exactly one
        // month, same as a first subscribe. Subscribed ~2 months ago, so the old window ended ~a
        // month before this re-activation.
        Instant subscribed = Instant.now().minus(Duration.ofDays(60));
        Subscription subscription = activeSubscription(subscribed);
        subscription.cancelAtPeriodEnd(subscribed.plus(Duration.ofDays(3)));
        assertThat(subscription.getCurrentPeriodEnd()).isBefore(Instant.now()); // precondition: expired

        Instant reactivation = Instant.now();
        subscription.activate(MembershipTier.MONTHLY, "revolut", "cust-1", reactivation);

        assertThat(subscription.getCurrentPeriodEnd()).isEqualTo(Subscription.plusOneMonth(reactivation));
    }
}
