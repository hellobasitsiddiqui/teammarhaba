package com.teammarhaba.backend.notify;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.notify.BroadcastResult.Outcome;
import com.teammarhaba.backend.notify.BroadcastResult.RecipientResult;
import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.BadRequestException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Admin broadcast fan-out (TM-363, epic TM-358): deliver one custom notification (title + body +
 * optional deep-link route) to a chosen set of accounts and record what happened.
 *
 * <p>This is the deliberate <strong>base</strong> fan-out. It <em>reuses</em> the existing single-user
 * plumbing rather than reimplementing any of it: the route allow-list check mirrors
 * {@code UserAdminService.sendTestPush} (validate once, up-front, so an off-list route is a clean
 * {@code 400} — never a {@code 500}), and delivery is one {@link PushMessage} looped through
 * {@link PushNotificationService#sendToUser} per resolved recipient. Token resolution, FCM,
 * {@code UNREGISTERED}-token pruning and the TM-292 outcome classification all stay inside
 * {@code sendToUser}/{@code FcmPushSender} — this method never touches a token.
 *
 * <p><strong>Partial failure is not total failure.</strong> A missing/absent user id is reported as a
 * {@link Outcome#NOT_FOUND} recipient (never thrown), and a user with no devices as
 * {@link Outcome#NO_DEVICES}; transient per-token FCM failures are already absorbed inside
 * {@code sendToUser}. The only hard {@code 400}s are malformed input (Bean Validation on the DTO) and
 * an off-list {@code route} (here). So the endpoint returns {@code 200} with a per-recipient breakdown
 * whenever the request itself was well-formed.
 *
 * <p><strong>Auditing.</strong> The whole send runs in one transaction and, on completion, writes
 * exactly one {@link NotificationBroadcast} header row <em>and</em> one
 * {@link AuditAction#BROADCAST_SENT} audit summary row, so a broadcast is never silently un-recorded.
 * Metadata carries counts/title/route only — <strong>never device tokens</strong> (a token is a
 * sender-usable credential; the whole notify stack keeps them out of logs/audit).
 *
 * <p><strong>Scope.</strong> Opt-out / skip-disabled / dedupe filtering (the {@code SKIPPED_*}
 * outcomes) is layered by the safety task (TM-364), which extends this without changing
 * {@code sendToUser}'s signature (reused by the re-enable and test-push paths). Batched
 * {@code sendEachForMulticast} (500/call) is an explicit future optimisation, out of v1.
 */
@Service
public class BroadcastService {

    private static final Logger log = LoggerFactory.getLogger(BroadcastService.class);

    /** Audit {@code target_type} for a broadcast — the kind of thing acted on. */
    private static final String TARGET_TYPE = "Broadcast";

    private final UserRepository users;
    private final PushNotificationService push;
    private final NotificationBroadcastRepository broadcasts;
    private final AuditService audit;

    public BroadcastService(
            UserRepository users,
            PushNotificationService push,
            NotificationBroadcastRepository broadcasts,
            AuditService audit) {
        this.users = users;
        this.push = push;
        this.broadcasts = broadcasts;
        this.audit = audit;
    }

    /**
     * Broadcast {@code title}/{@code body} (with optional {@code route}) to every account in
     * {@code userIds}, on behalf of the admin {@code actorUid}. Validates the route once (off-list →
     * {@code 400}), fans the message out per recipient, aggregates the per-user outcomes, then persists
     * one broadcast header row and one {@code BROADCAST_SENT} audit row in this transaction. Returns the
     * aggregate + per-recipient result.
     *
     * @param actorUid Firebase UID of the admin sending the broadcast (attribution; never null)
     * @param userIds  the {@code users.id} values to deliver to (validated non-empty/capped at the web edge)
     * @param title    the notification headline (validated non-blank/bounded at the web edge)
     * @param body     the notification body (validated non-blank/bounded at the web edge)
     * @param route    an optional known deep-link route ({@code null} = none); an off-list route is a 400
     * @return the aggregate counters plus the per-recipient breakdown
     * @throws BadRequestException if {@code route} is non-null and not on the {@link PushRoutes} allow-list
     */
    @Transactional
    public BroadcastResult broadcast(
            String actorUid, List<Long> userIds, String title, String body, String route) {
        // Validate the route once, up-front — mirrors UserAdminService.sendTestPush — so an off-list
        // route is a clean 400 BEFORE we construct the (last-line-guarded) PushMessage or send anything.
        if (route != null && !PushRoutes.isKnown(route)) {
            throw new BadRequestException(
                    "Unknown push route '" + route + "'. Allowed: " + PushRoutes.KNOWN);
        }

        PushMessage message = new PushMessage(title, body, route);

        List<RecipientResult> recipients = new ArrayList<>(userIds.size());
        int sent = 0;
        int skipped = 0;
        int targeted = 0;
        int delivered = 0;
        int pruned = 0;
        int failed = 0;

        for (Long userId : userIds) {
            User user = users.findById(userId).orElse(null);
            if (user == null) {
                // A missing/absent (or soft-deleted) id is reported, not fatal — the rest still send.
                recipients.add(new RecipientResult(userId, Outcome.NOT_FOUND, PushFanout.EMPTY));
                skipped++;
                continue;
            }

            PushFanout fanout = push.sendToUser(user.getId(), message);
            Outcome outcome = fanout.targeted() == 0 ? Outcome.NO_DEVICES : Outcome.SENT;
            recipients.add(new RecipientResult(userId, outcome, fanout));

            if (outcome == Outcome.SENT) {
                sent++;
            } else {
                skipped++; // resolved to a real account but had zero devices to deliver to
            }
            targeted += fanout.targeted();
            delivered += fanout.delivered();
            pruned += fanout.pruned();
            failed += fanout.failed();
        }

        BroadcastResult result = new BroadcastResult(
                userIds.size(), sent, skipped, targeted, delivered, pruned, failed, recipients);

        record(actorUid, title, body, route, result);
        return result;
    }

    /**
     * Persist the durable trace of a broadcast: one {@link NotificationBroadcast} header row and one
     * {@link AuditAction#BROADCAST_SENT} audit summary, both in the caller's transaction. Audit metadata
     * is counts/title/route only — never tokens.
     */
    private void record(
            String actorUid, String title, String body, String route, BroadcastResult result) {
        NotificationBroadcast header = broadcasts.save(new NotificationBroadcast(
                actorUid,
                title,
                body,
                route,
                result.requested(),
                result.targeted(),
                result.delivered(),
                result.pruned(),
                result.failed(),
                result.skipped()));

        audit.record(
                actorUid,
                AuditAction.BROADCAST_SENT,
                TARGET_TYPE,
                String.valueOf(header.getId()),
                Map.of(
                        "recipientCount", result.requested(),
                        "sent", result.sent(),
                        "skipped", result.skipped(),
                        "delivered", result.delivered(),
                        "failed", result.failed(),
                        "title", title,
                        "route", route == null ? "" : route));

        log.info(
                "Broadcast {} by {}: requested={}, sent={}, skipped={}, delivered={}, pruned={}, failed={}",
                header.getId(),
                actorUid,
                result.requested(),
                result.sent(),
                result.skipped(),
                result.delivered(),
                result.pruned(),
                result.failed());
    }
}
