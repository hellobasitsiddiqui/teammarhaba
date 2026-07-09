package com.teammarhaba.backend.notify;

import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Creates durable {@link Notification} rows in a user's inbox from the app's admin + system sources
 * (TM-453, group-notifications). This is the <em>write</em> half of the notification store
 * (TM-452 owns the entity/table/repository): every place that already fires a transient push — the
 * event lifecycle edit/cancel seam, the reminder fan-out, the waitlist offer cascade, the claim
 * confirmation, and (once TM-441 lands) the admin send — also calls a typed method here so the same
 * notification SURVIVES as a bell/panel row after the push is gone (the TM-374 gap a push alone
 * leaves).
 *
 * <p><b>Who a write targets — the in-app inbox is push-pref-independent.</b> The push rails
 * ({@code EventAttendeeNotifier} / {@code EventReminderService}) drop anyone whose
 * {@code notificationPref} opted out of push ({@code EMAIL}); the durable inbox does <em>not</em> —
 * an {@code EMAIL}-pref user still opens the app and reads the bell, so they must get the row. This
 * writer therefore resolves the affected users <em>through</em> {@link UserRepository} (so a
 * soft-deleted/tombstoned account is dropped by the entity's {@code @SQLRestriction}, and a suspended
 * {@code enabled == false} account is skipped — same account rails as everywhere else) but applies
 * <b>no</b> pref filter. Callers pass the full domain-affected set (GOING attendees, the claimant,
 * the offered members, the admin recipients); this class narrows it to real, active accounts.
 *
 * <p><b>Idempotency — no duplicate per source event (an AC).</b> Each write carries a
 * {@code sourceRef} that uniquely identifies the source event (e.g. {@code event:42:reminder:T_MINUS_1H},
 * {@code event:42:updated:v7}); before inserting for a user this writer checks
 * {@link NotificationRepository#existsByUserIdAndTypeAndSourceRef} and skips a row that already
 * exists. So a listener that fires twice, an at-least-once redelivery, or a retried sweep can never
 * double-write a user's inbox. The seams themselves are already at-most-once (the reminder claim row,
 * the offer stamp, a single {@code AFTER_COMMIT} publication), so this guard is the belt to their
 * braces — and it makes each writer method provably idempotent in isolation, which is what the
 * per-source tests assert. Input user ids are de-duplicated first so a caller repeating an id can't
 * slip a duplicate past the existence check before the first insert flushes.
 *
 * <p><b>Retention.</b> After each insert the writer trims that user's inbox via
 * {@link NotificationRepository#purgeForUser} — the store's locked policy (keep the last 50
 * non-sticky per user, all sticky exempt), applied continuously at write time rather than by a sweep,
 * exactly as {@link NotificationRepository} documents its writers should.
 *
 * <p><b>Transactions.</b> Every public method runs {@link Propagation#REQUIRES_NEW}. Two of the call
 * sites are {@code @TransactionalEventListener(AFTER_COMMIT)} listeners, where the publishing
 * transaction is committed but still bound to the thread; a plain {@code REQUIRED} would try to join
 * that dead transaction and the {@code @Modifying} purge would fail with
 * {@code TransactionRequiredException} (the same trap {@code WaitlistOfferCascadeService#killCascade}
 * documents). A fresh transaction gives the insert+purge a live one to run in, whether the caller
 * holds a (committed) transaction or none at all.
 */
@Service
public class NotificationWriter {

    private final NotificationRepository notifications;
    private final UserRepository users;

    public NotificationWriter(NotificationRepository notifications, UserRepository users) {
        this.notifications = notifications;
        this.users = users;
    }

    /**
     * Write a system notification (event lifecycle / reminder / offer / RSVP) for every affected user,
     * reusing the exact {@link PushMessage} the seam already built so the stored row's title, body and
     * deep-link match the push verbatim (including any reveal-gating baked into the push copy).
     *
     * @param type      the notification type (e.g. {@code EVENT_UPDATED}); never {@code ADMIN_MESSAGE}
     * @param userIds   the domain-affected users (resolved to active accounts here); may be empty
     * @param message   the push message to persist — its {@code route()} becomes the deep-link
     * @param sourceRef the source-event key for idempotency + cross-linking (see class doc)
     * @return how many inbox rows were actually written (skips already-present ones and inactive users)
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int writeSystem(
            NotificationType type, Collection<Long> userIds, PushMessage message, String sourceRef) {
        return writeEach(type, userIds, message.title(), message.body(), message.route(), sourceRef, false);
    }

    /**
     * Convenience for a single-recipient system notification — the waitlist claim confirmation, whose
     * one affected user is the claimant. Same idempotent, active-account-only behaviour as
     * {@link #writeSystem}.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int writeSystemToUser(NotificationType type, long userId, PushMessage message, String sourceRef) {
        return writeEach(type, List.of(userId), message.title(), message.body(), message.route(), sourceRef, false);
    }

    /**
     * Write an {@code ADMIN_MESSAGE} notification for every recipient of an admin send — the only path
     * allowed to pin a notification ({@code sticky}). Ready for the TM-441 admin-send endpoint to call
     * once it lands; until then it is exercised directly by tests. Title/body/deep-link are supplied by
     * the admin path (which validates the route against the stricter admin allow-list before calling),
     * not derived from a {@link PushMessage}.
     *
     * @param userIds   the resolved recipient account ids (e.g. from {@code RecipientResolver})
     * @param title     the message headline
     * @param body      the message body
     * @param deepLink  optional in-app route to open on tap ({@code null} = none)
     * @param sourceRef the campaign/message key for idempotency + cross-linking
     * @param sticky    whether to pin the notification (exempt from the retention purge)
     * @return how many inbox rows were actually written
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int writeAdminMessage(
            Collection<Long> userIds,
            String title,
            String body,
            String deepLink,
            String sourceRef,
            boolean sticky) {
        return writeEach(NotificationType.ADMIN_MESSAGE, userIds, title, body, deepLink, sourceRef, sticky);
    }

    /**
     * The shared per-user write: narrow {@code userIds} to active accounts, then for each (in caller
     * order) insert one {@link Notification} — skipping any that already exists for this
     * {@code (userId, type, sourceRef)} — and trim the user's inbox to the retention cap. Runs inside
     * the public method's {@code REQUIRES_NEW} transaction.
     */
    private int writeEach(
            NotificationType type,
            Collection<Long> userIds,
            String title,
            String body,
            String deepLink,
            String sourceRef,
            boolean sticky) {
        // De-duplicate up front so a repeated id can't slip a second row past the existence check
        // before the first insert is visible, and preserve caller order for stable, reviewable writes.
        Set<Long> distinct = new LinkedHashSet<>(userIds);
        if (distinct.isEmpty()) {
            return 0;
        }

        // Resolve people THROUGH the User aggregate (one batch read): a tombstoned account is hidden by
        // the entity's @SQLRestriction and never appears here even if its attendance/device rows survive.
        Map<Long, User> byId = users.findAllById(distinct).stream()
                .collect(Collectors.toMap(User::getId, Function.identity()));

        int written = 0;
        for (Long userId : distinct) {
            User user = byId.get(userId);
            if (user == null || !user.isEnabled()) {
                continue; // not found / soft-deleted, or suspended — no inbox to write to
            }
            // Idempotency guard: one row per (user, type, sourceRef). A null sourceRef is un-dedupable
            // (a free-standing notification), so it always writes.
            if (sourceRef != null
                    && notifications.existsByUserIdAndTypeAndSourceRef(user.getId(), type, sourceRef)) {
                continue;
            }
            notifications.save(new Notification(user.getId(), type, title, body, deepLink, sourceRef, sticky));
            notifications.purgeForUser(user.getId()); // continuous retention: keep last 50 non-sticky + all sticky
            written++;
        }
        return written;
    }
}
