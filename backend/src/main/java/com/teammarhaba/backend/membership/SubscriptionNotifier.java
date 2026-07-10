package com.teammarhaba.backend.membership;

import com.teammarhaba.backend.notify.NotificationType;
import com.teammarhaba.backend.notify.NotificationWriter;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushNotificationService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Subscription lifecycle notifications (TM-620): the started / renewed / payment-failed / ended
 * messages, delivered over the existing rails — a transient push ({@link PushNotificationService},
 * TM-283) plus the durable in-app inbox row ({@link NotificationWriter}, TM-452/453) so the message
 * survives after the push is gone. All deep-link to the membership screen ({@code #/membership},
 * allow-listed in {@code PushRoutes} / {@code push-deeplink.js}).
 *
 * <p><strong>Idempotent per source event.</strong> Every write carries a {@code sourceRef} unique to
 * the billing event (e.g. {@code subscription:42:renewed:2026-08-10T…} — the new period end), so a
 * retried scheduler pass or a duplicated webhook can never double-write a user's inbox (the
 * {@link NotificationWriter} existence guard). Pushes are transient; a rare duplicate push is
 * acceptable, a duplicate inbox row is not.
 *
 * <p><strong>Never on the money path.</strong> Notification delivery is best-effort: a push/FCM
 * hiccup is logged and swallowed so it can never roll back the billing transaction that triggered it.
 */
@Component
public class SubscriptionNotifier {

    private static final Logger log = LoggerFactory.getLogger(SubscriptionNotifier.class);

    /** Where every subscription notification lands the user — their membership management screen. */
    private static final String MEMBERSHIP_ROUTE = "#/membership";

    private final PushNotificationService push;
    private final NotificationWriter writer;

    public SubscriptionNotifier(PushNotificationService push, NotificationWriter writer) {
        this.push = push;
        this.writer = writer;
    }

    /** The subscription activated: first charge settled, card saved, paid tier granted. */
    public void subscriptionStarted(Long userId, MembershipTier tier, String sourceRef) {
        deliver(
                userId,
                NotificationType.SUBSCRIPTION_STARTED,
                new PushMessage(
                        "You're subscribed!",
                        "Your " + tierLabel(tier) + " membership is active. Enjoy your events!",
                        MEMBERSHIP_ROUTE),
                sourceRef);
    }

    /** A monthly renewal settled and the paid window rolled forward. */
    public void renewalSucceeded(Long userId, MembershipTier tier, String sourceRef) {
        deliver(
                userId,
                NotificationType.SUBSCRIPTION_RENEWED,
                new PushMessage(
                        "Membership renewed",
                        "Your " + tierLabel(tier) + " membership renewed for another month.",
                        MEMBERSHIP_ROUTE),
                sourceRef);
    }

    /** A renewal charge failed; dunning retries are running — nudge the user to check their card. */
    public void renewalFailed(Long userId, MembershipTier tier, String sourceRef) {
        deliver(
                userId,
                NotificationType.SUBSCRIPTION_PAYMENT_FAILED,
                new PushMessage(
                        "Payment problem",
                        "We couldn't renew your " + tierLabel(tier)
                                + " membership. We'll retry over the next few days — please check your card.",
                        MEMBERSHIP_ROUTE),
                sourceRef);
    }

    /** The subscription ended (cancel reached period end, or dunning exhausted) — downgraded to free. */
    public void subscriptionEnded(Long userId, MembershipTier tier, boolean dunningExhausted, String sourceRef) {
        String body = dunningExhausted
                ? "We couldn't take your " + tierLabel(tier)
                        + " renewal payment, so your account is back on pay-per-event. Resubscribe any time."
                : "Your " + tierLabel(tier)
                        + " membership has ended and your account is back on pay-per-event. Resubscribe any time.";
        deliver(
                userId,
                NotificationType.SUBSCRIPTION_ENDED,
                new PushMessage("Membership ended", body, MEMBERSHIP_ROUTE),
                sourceRef);
    }

    /** Human tier name for copy ("Monthly" / "Diamond") — enum names are shouty for a notification. */
    private static String tierLabel(MembershipTier tier) {
        return switch (tier) {
            case MONTHLY -> "Monthly";
            case DIAMOND -> "Diamond";
            case PAY_PER_EVENT -> "Pay per event";
        };
    }

    /**
     * The shared delivery: durable inbox row first (idempotent by {@code sourceRef}; its own
     * {@code REQUIRES_NEW} transaction), then the best-effort push. Both wrapped so a notification
     * failure can never fail the billing transaction that triggered it.
     */
    private void deliver(Long userId, NotificationType type, PushMessage message, String sourceRef) {
        try {
            writer.writeSystemToUser(type, userId, message, sourceRef);
        } catch (RuntimeException e) {
            log.warn("Failed to write {} inbox notification for user {}", type, userId, e);
        }
        try {
            push.sendToUser(userId, message);
        } catch (RuntimeException e) {
            log.warn("Failed to push {} notification to user {}", type, userId, e);
        }
    }
}
