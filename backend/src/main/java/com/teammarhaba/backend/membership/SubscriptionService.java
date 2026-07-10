package com.teammarhaba.backend.membership;

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
import jakarta.persistence.EntityNotFoundException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The recurring-subscription lifecycle (TM-620 / epic Membership): Subscribe checkout, webhook-driven
 * activation, and cancel. The renewal/dunning engine lives in {@link SubscriptionRenewalService}; this
 * class owns everything a user (or a webhook about a user's payment) drives directly.
 *
 * <p><strong>Server-side flag (TM-623).</strong> {@link #checkout} and {@link #cancel} are 404 while
 * {@code app.membership.enabled} is off: the web {@code membership} flag only hides UI, so without this
 * gate any authenticated caller could open real provider orders (and thereby a live recurring
 * subscription) by curling the endpoints. Reads ({@link #find}, {@link #adminView}) stay open — they
 * move no money. The webhook confirm ({@link #confirmCharge}) also stays open: it settles charges that
 * were legitimately opened while the flag WAS on (a flag rollback must not strand in-flight money).
 *
 * <p><strong>Subscribe checkout</strong> ({@link #checkout}) — the separate paid flow the product
 * decision mandates (tier-switch stays free-of-charge until subscribed): registers a provider Customer
 * for the account, opens a provider order for the tier's monthly price <em>attached to that customer</em>
 * (which is what lets the widget save the card against it), records a {@code PENDING INITIAL}
 * {@link SubscriptionCharge}, and returns the widget token. The browser mounts the Revolut card field
 * with {@code savePaymentMethodFor: "merchant"} and the customer completes SCA/3DS there — the first
 * charge is the SCA-authenticated transaction the whole future MIT mandate anchors on.
 *
 * <p><strong>Activation</strong> ({@link #confirmCharge}) — driven by the verified payment webhook
 * (the same rail that settles event orders, {@code PaymentWebhookService}): marks the charge PAID,
 * creates (or resets, on a re-subscribe) the one {@link Subscription} row as ACTIVE with a rolling
 * monthly period anchored at the settle time, resolves + stores the merchant-saved payment method for
 * renewals, grants the paid tier through {@link MembershipService#applyTierForSubscription}, audits and
 * notifies. Idempotent: a repeat webhook finds the charge already PAID and does nothing — and the
 * "already PAID?" check reads state re-fetched UNDER the user lock ({@code EntityManager.refresh}),
 * because a repository re-query would return the same stale first-level-cache instance and truly
 * concurrent duplicate deliveries would both pass the check (TM-623).
 *
 * <p><strong>Cancel</strong> ({@link #cancel}) — stop renewals, keep the tier: the subscription flips
 * to CANCELED with its "due" pointer parked at the period end, where the renewal scheduler performs the
 * downgrade to pay-per-event (TM-598-aligned semantics). Idempotent.
 *
 * <p><strong>Locking.</strong> Every mutating path takes the caller's user-row lock first
 * ({@link UserService#lockForUpdate} — the TM-423 convention), so a subscribe, a duplicate webhook and
 * a renewal pass over the same account serialise instead of racing.
 */
@Service
public class SubscriptionService {

    private static final Logger log = LoggerFactory.getLogger(SubscriptionService.class);

    /** Audit {@code target_type} for subscription events. */
    static final String TARGET_SUBSCRIPTION = "Subscription";

    /** The single currency subscriptions charge in — prices are defined in GBP pence (V38). */
    private static final String CURRENCY = "GBP";

    /** The 404 copy when the server-side membership flag is off — the feature does not exist yet. */
    static final String MEMBERSHIP_OFF = "Subscriptions are not available.";

    private final SubscriptionRepository subscriptions;
    private final SubscriptionChargeRepository charges;
    private final MembershipService memberships;
    private final UserService users;
    private final PaymentProvider payments;
    private final AuditService audit;
    private final SubscriptionNotifier notifier;
    private final MembershipProperties membershipProps;
    private final EntityManager entityManager;

    public SubscriptionService(
            SubscriptionRepository subscriptions,
            SubscriptionChargeRepository charges,
            MembershipService memberships,
            UserService users,
            PaymentProvider payments,
            AuditService audit,
            SubscriptionNotifier notifier,
            MembershipProperties membershipProps,
            EntityManager entityManager) {
        this.subscriptions = subscriptions;
        this.charges = charges;
        this.memberships = memberships;
        this.users = users;
        this.payments = payments;
        this.audit = audit;
        this.notifier = notifier;
        this.membershipProps = membershipProps;
        this.entityManager = entityManager;
    }

    /**
     * Open a Subscribe checkout for {@code tier} (TM-620) — see the class doc for the full flow. The
     * provider calls run inside this transaction (holding the caller's user-row lock): if the provider
     * rejects/times out, the whole checkout rolls back leaving no orphan charge row.
     *
     * <p>Re-entrant: a caller who abandoned a previous attempt re-uses the still-PENDING INITIAL charge
     * (re-pointed at a fresh provider order — the widget token is single-use; the SUPERSEDED provider
     * order is voided best-effort so a stale open widget can no longer capture money nothing would
     * reconcile, TM-623), and a caller with a CANCELED/PAST_DUE subscription may subscribe again (the
     * activation resets the row). Only a currently-ACTIVE subscription blocks with a {@code 409} —
     * mid-cycle tier changes are a follow-up (cancel first, resubscribe after the period ends).
     *
     * @throws ResourceNotFoundException while the server-side membership flag is off (TM-623)
     * @throws BadRequestException       for the free base tier — there is nothing to subscribe to
     * @throws ConflictException         when an ACTIVE subscription already exists
     */
    @Transactional
    public SubscriptionCheckout checkout(VerifiedUser caller, MembershipTier tier) {
        requireMembershipEnabled();
        if (!SubscriptionPricing.isPaidTier(tier)) {
            throw new BadRequestException("Choose a paid tier to subscribe to (MONTHLY or DIAMOND).");
        }
        User user = users.provision(caller);
        users.lockForUpdate(user.getId()); // serialise with webhooks + renewal passes on this account
        Instant now = Instant.now();

        Subscription existing = subscriptions.findByUserId(user.getId()).orElse(null);
        if (existing != null && existing.getStatus() == SubscriptionStatus.ACTIVE) {
            throw new ConflictException(existing.getTier() == tier
                    ? "You already have an active subscription."
                    : "You already have an active subscription — cancel it before switching tier.");
        }

        int amountPence = SubscriptionPricing.monthlyPricePence(tier);

        // Reuse the provider customer a previous subscription registered (same gateway), else create one —
        // the container the widget saves the card into and renewals charge through. The phone number
        // rides along (TM-623) so a phone-only account (no email, often no name) still registers a
        // customer with a real identifying field.
        String customerId = existing != null
                        && existing.getProviderCustomerId() != null
                        && payments.name().equals(existing.getProvider())
                ? existing.getProviderCustomerId()
                : payments.createCustomer(user.getEmail(), user.getPhone(), user.getDisplayName());

        // One PENDING INITIAL charge per account: re-use (re-point) an abandoned attempt rather than
        // accumulating a dead row per click. Saved first so its id is the merchant reference.
        SubscriptionCharge charge = charges.findFirstByUserIdAndKindAndStatus(
                        user.getId(), SubscriptionCharge.Kind.INITIAL, SubscriptionCharge.Status.PENDING)
                .orElse(null);
        if (charge == null) {
            charge = charges.save(new SubscriptionCharge(
                    user.getId(), SubscriptionCharge.Kind.INITIAL, tier, amountPence, now));
        } else {
            // Void the superseded provider order BEFORE forgetting it (TM-623): its single-use widget
            // token may still be mounted in another tab, and once this row re-points, a payment against
            // the old order would match neither ledger — money captured, nothing activated, no record.
            // Best-effort: a failed cancel (network, already paid) must not block the new checkout —
            // the old order id is logged so the Revolut dashboard can reconcile it manually.
            if (charge.getProviderOrderId() != null) {
                try {
                    payments.cancelOrder(charge.getProviderOrderId());
                } catch (PaymentProviderException e) {
                    log.warn(
                            "Could not void superseded provider order {} while re-pointing the INITIAL "
                                    + "charge for user {} — reconcile it manually if it is ever paid.",
                            charge.getProviderOrderId(),
                            user.getId(),
                            e);
                }
            }
            charge.repointInitialAttempt(tier, amountPence, now);
        }

        PaymentOrder order = payments.createOrderForCustomer(
                amountPence, CURRENCY, "sub-charge:" + charge.getId(), customerId);
        charge.setPaymentReference(payments.name(), order.id(), customerId, now);
        return new SubscriptionCheckout(tier, amountPence, order.token(), payments.name());
    }

    /**
     * Settle a subscription charge on a verified payment webhook (TM-620) — the subscription counterpart
     * of {@code CheckoutService.confirmPayment}, called for every settled payment event (each ignores
     * order ids it does not own, so the two ledgers never clash). An INITIAL charge activates the
     * subscription; a RENEWAL charge is the idempotent async backstop for the synchronous pay-order call
     * — including healing a FAILED row the provider later reports paid (real money ⇒ real period).
     *
     * <p>Idempotent: an unknown provider order id, or a charge already PAID, is a silent no-op. The
     * PAID check runs on state re-read fresh under the user lock (TM-623) — see the class doc.
     */
    @Transactional
    public void confirmCharge(String providerOrderId) {
        // Resolve once to learn which user to lock, then re-read + REFRESH under that lock so a
        // duplicate delivery (or a racing renewal pass) serialises — the refresh matters because the
        // repository re-query would resolve to the same already-managed instance with its pre-lock
        // field values, making the "already PAID" idempotency check a no-op under a real race.
        Long userId = charges.findByProviderOrderId(providerOrderId)
                .map(SubscriptionCharge::getUserId)
                .orElse(null);
        if (userId == null) {
            return; // not a subscription charge (an event order, or not ours) — nothing to do
        }
        users.lockForUpdate(userId);

        SubscriptionCharge charge =
                charges.findByProviderOrderId(providerOrderId).orElse(null);
        if (charge == null) {
            return; // gone (or re-pointed away) while we waited — idempotent no-op
        }
        try {
            entityManager.refresh(charge); // committed state, not the stale L1-cache snapshot (TM-623)
        } catch (EntityNotFoundException gone) {
            return; // row deleted while we waited for the lock
        }
        if (charge.getStatus() == SubscriptionCharge.Status.PAID) {
            return; // a repeat webhook — idempotent no-op
        }

        Instant now = Instant.now();
        if (charge.getKind() == SubscriptionCharge.Kind.INITIAL) {
            activate(charge, now);
        } else {
            healRenewal(charge, now);
        }
    }

    /**
     * Stop renewals (TM-620): flip the subscription to CANCELED, keeping the paid tier until the period
     * end — the scheduler (whose "due" pointer the cancel parks exactly there) performs the downgrade.
     * Idempotent: cancelling an already-CANCELED subscription returns it unchanged.
     *
     * @throws ResourceNotFoundException while the server-side membership flag is off (TM-623), or when
     *                                   the caller has no subscription at all
     */
    @Transactional
    public Subscription cancel(VerifiedUser caller) {
        requireMembershipEnabled();
        User user = users.provision(caller);
        users.lockForUpdate(user.getId());
        Subscription subscription = subscriptions
                .findByUserId(user.getId())
                .orElseThrow(() -> new ResourceNotFoundException("You don't have a subscription."));
        if (subscription.getStatus() == SubscriptionStatus.CANCELED) {
            return subscription; // idempotent repeat
        }
        Instant now = Instant.now();
        subscription.cancelAtPeriodEnd(now);
        audit.record(
                caller.uid(),
                AuditAction.SUBSCRIPTION_CANCELED,
                TARGET_SUBSCRIPTION,
                String.valueOf(user.getId()),
                Map.of(
                        "tier", subscription.getTier().name(),
                        "periodEnd", subscription.getCurrentPeriodEnd().toString()));
        return subscription;
    }

    /** The caller's subscription, if they have one (TM-620). Read-only; never enrols anything. */
    @Transactional
    public Optional<Subscription> find(VerifiedUser caller) {
        User user = users.provision(caller);
        return subscriptions.findByUserId(user.getId());
    }

    /** Admin view (TM-620): one account's subscription state + its billing history, newest first. */
    @Transactional(readOnly = true)
    public AdminView adminView(Long userId) {
        return new AdminView(
                subscriptions.findByUserId(userId).orElse(null),
                charges.findTop50ByUserIdOrderByCreatedAtDescIdDesc(userId));
    }

    /** One account's subscription state (nullable — never subscribed) + charge history for the admin console. */
    public record AdminView(Subscription subscription, List<SubscriptionCharge> charges) {}

    /** 404 unless the server-side membership flag is on (TM-623) — money paths do not exist while off. */
    private void requireMembershipEnabled() {
        if (!membershipProps.enabled()) {
            throw new ResourceNotFoundException(MEMBERSHIP_OFF);
        }
    }

    /**
     * The webhook-confirmed first charge: create (or reset, on a re-subscribe) the account's one
     * subscription row as ACTIVE with a fresh rolling period, store the merchant-saved card for
     * renewals, grant the tier, audit and notify. Runs under the user-row lock taken by
     * {@link #confirmCharge}.
     */
    private void activate(SubscriptionCharge charge, Instant now) {
        Subscription subscription = subscriptions
                .findByUserId(charge.getUserId())
                .map(existing -> {
                    existing.activate(charge.getTier(), charge.getProvider(), charge.getProviderCustomerId(), now);
                    return existing;
                })
                .orElseGet(() -> subscriptions.save(new Subscription(
                        charge.getUserId(), charge.getTier(), charge.getProvider(),
                        charge.getProviderCustomerId(), now)));
        charge.markPaid(subscription.getCurrentPeriodStart(), subscription.getCurrentPeriodEnd(), now);

        // Resolve the card the widget just saved (saved_for=MERCHANT) so renewals can charge it. Best
        // effort: a hiccup here must not lose the activation — a renewal with no stored ref re-fetches.
        try {
            payments.findMerchantSavedPaymentMethod(subscription.getProviderCustomerId())
                    .ifPresent(ref -> subscription.savePaymentMethodRef(ref, now));
        } catch (PaymentProviderException e) {
            log.warn("Could not resolve saved payment method for user {} at activation", charge.getUserId(), e);
        }
        if (subscription.getSavedPaymentMethodRef() == null) {
            log.warn("No merchant-saved payment method found for user {} at activation", charge.getUserId());
        }

        // Grant the paid tier — the ungated, audited subscription-driven path (never switchTier).
        User user = users.getById(charge.getUserId());
        memberships.applyTierForSubscription(user.getId(), charge.getTier(), user.getFirebaseUid());

        audit.record(
                user.getFirebaseUid(),
                AuditAction.SUBSCRIPTION_STARTED,
                TARGET_SUBSCRIPTION,
                String.valueOf(user.getId()),
                Map.of(
                        "tier", charge.getTier().name(),
                        "periodEnd", subscription.getCurrentPeriodEnd().toString()));
        // Charge-id sourceRef (TM-623): the old ref embedded currentPeriodStart — a per-transaction
        // timestamp that differed between two racing duplicate deliveries by milliseconds, so the
        // notification dedupe never matched and the user got duplicate "You're subscribed!" rows
        // (NotificationWriter commits in REQUIRES_NEW, surviving the loser's rollback). The charge id
        // is stable across deliveries of the same event.
        notifier.subscriptionStarted(
                user.getId(),
                charge.getTier(),
                "subscription-charge:" + charge.getId() + ":started");
    }

    /**
     * The async backstop for a renewal charge (TM-620): the synchronous pay-order call already settles
     * renewals, so the common webhook is a no-op (charge already PAID, caught upstream). Two real cases
     * remain: a charge the sync path saw fail that the provider later reports settled (heal it — the
     * money moved, so the period it bought must exist), and a webhook overtaking a slow sync response.
     * The period-window comparison keeps it idempotent: only a charge buying time BEYOND the current
     * period end extends anything.
     *
     * <p><strong>A CANCELED subscription is never resurrected (TM-623).</strong> The heal extends the
     * paid window via {@link Subscription#extendPeriodTo}, which grants the time but keeps a CANCELED
     * status CANCELED — flipping it back to ACTIVE would re-arm auto-renewal against a card whose owner
     * explicitly cancelled (the classic dunning-notification → user cancels → late settle sequence).
     */
    private void healRenewal(SubscriptionCharge charge, Instant now) {
        Subscription subscription =
                subscriptions.findByUserId(charge.getUserId()).orElse(null);
        // The paid window this charge was created to buy (stamped at creation by the renewal engine).
        charge.markPaid(charge.getPeriodStart(), charge.getPeriodEnd(), now);
        if (subscription == null || charge.getPeriodEnd() == null) {
            return; // nothing to extend (subscription gone) — the payment is still recorded as PAID
        }
        if (charge.getPeriodEnd().isAfter(subscription.getCurrentPeriodEnd())) {
            subscription.extendPeriodTo(charge.getPeriodStart(), charge.getPeriodEnd(), now);
            // Re-grant the tier in case dunning already downgraded the account before this settle
            // arrived. Tombstone-safe (TM-623): for a soft-deleted (or vanished) account the paid
            // window is recorded but nothing is granted or notified — the old getById threw here,
            // 500-ing the webhook into an endless redelivery loop.
            User user = users.findAnyById(charge.getUserId()).orElse(null);
            if (user == null || user.isDeleted()) {
                log.warn(
                        "Healed subscription charge {} for deleted/missing account {} — window recorded, "
                                + "no tier granted (TM-623).",
                        charge.getId(),
                        charge.getUserId());
                return;
            }
            memberships.applyTierForSubscription(user.getId(), subscription.getTier(), user.getFirebaseUid());
            audit.record(
                    user.getFirebaseUid(),
                    AuditAction.SUBSCRIPTION_RENEWED,
                    TARGET_SUBSCRIPTION,
                    String.valueOf(user.getId()),
                    Map.of(
                            "tier", subscription.getTier().name(),
                            "periodEnd", subscription.getCurrentPeriodEnd().toString(),
                            "via", "webhook"));
            notifier.renewalSucceeded(
                    user.getId(),
                    subscription.getTier(),
                    "subscription-charge:" + charge.getId() + ":renewed");
        } else {
            // Settled money that bought no NEW time: the window was already covered by another charge.
            // With one charge row per window this should not happen — flag it loudly as a potential
            // double payment needing a manual refund (TM-623), rather than silently absorbing it.
            log.warn(
                    "Settled subscription charge {} (provider order {}) bought no new period for user {} "
                            + "— possible duplicate payment; verify against the provider and refund if so.",
                    charge.getId(),
                    charge.getProviderOrderId(),
                    charge.getUserId());
        }
    }
}
