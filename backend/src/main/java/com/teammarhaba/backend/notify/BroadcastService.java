package com.teammarhaba.backend.notify;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.notify.BroadcastResult.Outcome;
import com.teammarhaba.backend.notify.BroadcastResult.RecipientResult;
import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.BadRequestException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Admin broadcast fan-out (TM-363, epic TM-358): deliver one custom notification (title + body +
 * optional deep-link route) to a chosen set of accounts, <em>with the safety rails that keep a blast
 * honest</em> (TM-364), and record what happened.
 *
 * <p>This is the deliberate <strong>base</strong> fan-out. Delivery reuses the existing single-user
 * plumbing rather than reimplementing FCM: the route allow-list check mirrors
 * {@code UserAdminService.sendTestPush} (validate once, up-front, so an off-list route is a clean
 * {@code 400} — never a {@code 500}), and the actual send goes through
 * {@link PushNotificationService#sendToTokens} so token resolution, FCM, {@code UNREGISTERED}-token
 * pruning and the TM-292 outcome classification all stay inside {@code PushNotificationService} /
 * {@code FcmPushSender}. The dumb single-user {@link PushNotificationService#sendToUser} (reused by the
 * re-enable and test-push paths) is left completely untouched — the rails live <em>here</em>.
 *
 * <p><strong>Safety rails (TM-364).</strong> Before anything is sent, each requested id is resolved and
 * gated, so a broadcast only ever reaches accounts that opted in and can receive it:
 *
 * <ul>
 *   <li><strong>Opt-out respected.</strong> A recipient whose {@link User#getNotificationPref()} does not
 *       {@linkplain NotificationPref#permitsPush() permit push} ({@link NotificationPref#PUSH} or
 *       {@link NotificationPref#BOTH}) is skipped ({@link Outcome#SKIPPED_OPTED_OUT}). New accounts now
 *       default to {@link NotificationPref#BOTH} (TM-427), so a broadcast reaches them once a device
 *       registers; an account set to {@link NotificationPref#EMAIL} is the push opt-out — there is no
 *       separate OFF value; EMAIL-only <em>is</em> the push opt-out.</li>
 *   <li><strong>Skip disabled.</strong> A suspended account ({@code enabled == false}) is skipped
 *       ({@link Outcome#SKIPPED_DISABLED}) — {@code sendToUser} does not check {@code enabled}, so this
 *       gate is explicit here.</li>
 *   <li><strong>Skip soft-deleted / absent.</strong> Recipients are resolved <em>through</em>
 *       {@link UserRepository} (whose entity {@code @SQLRestriction("deleted_at is null")} auto-excludes
 *       tombstoned rows), so a soft-deleted or unknown id is {@link Outcome#SKIPPED_NOT_FOUND} and never
 *       pushed. Soft-deleted users retain {@code device_tokens} rows, so resolving via tokens directly
 *       would be a leak — we always go through {@code User}, then read that user's tokens.</li>
 *   <li><strong>De-duplicate shared devices.</strong> The union of the eligible recipients' device
 *       tokens is de-duplicated by value, so a shared/handed-down device whose token maps under two
 *       selected users is pushed <em>once</em>, not per-recipient (the surplus is reported as
 *       {@code dedupedTokens}).</li>
 *   <li><strong>Empty-recipient guard.</strong> An empty id list is rejected ({@code 400}) — belt-and-
 *       braces alongside the DTO's {@code @NotEmpty}.</li>
 *   <li><strong>Accidental-double-send guard.</strong> A per-admin-uid cooldown (copied from
 *       {@code EmailVerificationService}: a {@link ConcurrentHashMap} + {@link #COOLDOWN} + injected
 *       {@link Clock}) rejects a second broadcast from the same admin inside the window with a
 *       {@link BroadcastCooldownException} ({@code 429}). It is <strong>process-local</strong> — fine
 *       for a single Cloud Run instance; a shared store (Redis) for a cluster-wide guard is the noted
 *       future improvement, consistent with TM-247. Only a broadcast that actually sends records the
 *       window; a rejected/short-circuited call never extends it.</li>
 * </ul>
 *
 * <p>The length caps on title/body are the DTO's {@code @Size} contract (mirrored client-side by the
 * compose UI, TM-365) plus the {@link PushMessage} constructor's last-line guard — so an oversized body
 * is a clean {@code 400}, never an FCM {@code INVALID_ARGUMENT} that lands as a FAILED token (TM-292).
 *
 * <p><strong>Partial failure is not total failure.</strong> A skipped recipient (opted out, disabled,
 * not found, or simply no devices) is <em>reported</em>, never thrown; transient per-token FCM failures
 * are absorbed inside the send. The only hard {@code 400}s are malformed input (Bean Validation on the
 * DTO), an empty id list, and an off-list {@code route}; the only {@code 429} is the cooldown. So a
 * well-formed request that isn't rate-limited returns {@code 200} with a per-recipient breakdown.
 *
 * <p><strong>Auditing.</strong> The whole send runs in one transaction and, on completion, writes
 * exactly one {@link NotificationBroadcast} header row <em>and</em> one
 * {@link AuditAction#BROADCAST_SENT} audit summary row (now including the skipped-by-rail + deduped
 * counts), so a broadcast is never silently un-recorded. Metadata carries counts/title/route only —
 * <strong>never device tokens</strong> (a token is a sender-usable credential; the whole notify stack
 * keeps them out of logs/audit).
 */
@Service
public class BroadcastService {

    private static final Logger log = LoggerFactory.getLogger(BroadcastService.class);

    /** Audit {@code target_type} for a broadcast — the kind of thing acted on. */
    private static final String TARGET_TYPE = "Broadcast";

    /**
     * Minimum gap between broadcasts from the same admin — the accidental-double-send guard. Copied
     * from {@code EmailVerificationService}'s cooldown pattern; conservative, and process-local (see
     * the class javadoc).
     */
    static final Duration COOLDOWN = Duration.ofSeconds(30);

    private final UserRepository users;
    private final DeviceTokenRepository deviceTokens;
    private final PushNotificationService push;
    private final NotificationBroadcastRepository broadcasts;
    private final AuditService audit;
    private final Clock clock;

    /** admin uid -> the instant of its last completed broadcast; entries persist for the process lifetime. */
    private final ConcurrentHashMap<String, Instant> lastBroadcast = new ConcurrentHashMap<>();

    @Autowired
    public BroadcastService(
            UserRepository users,
            DeviceTokenRepository deviceTokens,
            PushNotificationService push,
            NotificationBroadcastRepository broadcasts,
            AuditService audit) {
        this(users, deviceTokens, push, broadcasts, audit, Clock.systemUTC());
    }

    /** Test seam: inject a fixed/advanceable {@link Clock} to exercise the cooldown deterministically. */
    BroadcastService(
            UserRepository users,
            DeviceTokenRepository deviceTokens,
            PushNotificationService push,
            NotificationBroadcastRepository broadcasts,
            AuditService audit,
            Clock clock) {
        this.users = users;
        this.deviceTokens = deviceTokens;
        this.push = push;
        this.broadcasts = broadcasts;
        this.audit = audit;
        this.clock = clock;
    }

    /**
     * Broadcast {@code title}/{@code body} (with optional {@code route}) to every <em>eligible</em>
     * account in {@code userIds}, on behalf of the admin {@code actorUid}. Enforces the safety rails
     * (empty-list guard, per-admin cooldown, route allow-list, opt-out / disabled / not-found skipping,
     * shared-token de-duplication), fans the message out once per distinct token, aggregates the
     * per-user outcomes, then persists one broadcast header row and one {@code BROADCAST_SENT} audit row
     * in this transaction. Returns the aggregate + per-recipient result.
     *
     * @param actorUid Firebase UID of the admin sending the broadcast (attribution + cooldown key; never null)
     * @param userIds  the {@code users.id} values to deliver to (validated non-empty/capped at the web edge)
     * @param title    the notification headline (validated non-blank/bounded at the web edge)
     * @param body     the notification body (validated non-blank/bounded at the web edge)
     * @param route    an optional known deep-link route ({@code null} = none); an off-list route is a 400
     * @return the aggregate counters plus the per-recipient breakdown
     * @throws BadRequestException        if {@code userIds} is empty, or {@code route} is non-null and
     *                                    not on the {@link PushRoutes} allow-list
     * @throws BroadcastCooldownException if this admin sent a broadcast inside the {@link #COOLDOWN} window
     */
    @Transactional
    public BroadcastResult broadcast(
            String actorUid, List<Long> userIds, String title, String body, String route) {
        // Empty-recipient guard: belt-and-braces alongside the DTO @NotEmpty (also covers any non-web
        // caller). A blast to nobody is a 400, not a persisted no-op broadcast.
        if (userIds == null || userIds.isEmpty()) {
            throw new BadRequestException("A broadcast must target at least one recipient.");
        }

        // Validate the route once, up-front — mirrors UserAdminService.sendTestPush — so an off-list
        // route is a clean 400 BEFORE we construct the (last-line-guarded) PushMessage or send anything.
        if (route != null && !PushRoutes.isKnown(route)) {
            throw new BadRequestException(
                    "Unknown push route '" + route + "'. Allowed: " + PushRoutes.KNOWN);
        }

        // Accidental-double-send guard: reject a second broadcast from the same admin inside the window.
        // Checked before any send; the window is only *recorded* on a broadcast that actually completes
        // (see the end of this method), so a rejected/short-circuited call never extends it.
        Instant now = clock.instant();
        Instant previous = lastBroadcast.get(actorUid);
        if (previous != null && Duration.between(previous, now).compareTo(COOLDOWN) < 0) {
            throw new BroadcastCooldownException(
                    "A broadcast was sent very recently. Please wait a moment before sending another.");
        }

        PushMessage message = new PushMessage(title, body, route);

        List<RecipientResult> recipients = new ArrayList<>(userIds.size());
        int sent = 0;
        int skipped = 0;
        int skippedOptedOut = 0;
        int skippedDisabled = 0;
        int skippedNotFound = 0;
        int dedupedTokens = 0;
        int targeted = 0;
        int delivered = 0;
        int pruned = 0;
        int failed = 0;

        // Tokens already handed to the sender in THIS broadcast, so a device shared across two selected
        // recipients (a handed-down phone whose token maps under both) is pushed once, not per-recipient.
        // Insertion-ordered for stable, reviewable behaviour.
        Set<String> sentTokens = new LinkedHashSet<>();

        for (Long userId : userIds) {
            // Resolve THROUGH UserRepository: the entity's @SQLRestriction drops soft-deleted rows, so a
            // tombstoned (or unknown) id is SKIPPED_NOT_FOUND and never pushed — even though it may still
            // own device_tokens rows (those cascade only on hard delete). Never resolve via tokens.
            User user = users.findById(userId).orElse(null);
            if (user == null) {
                recipients.add(new RecipientResult(userId, Outcome.SKIPPED_NOT_FOUND, PushFanout.EMPTY));
                skippedNotFound++;
                skipped++;
                continue;
            }
            if (!user.isEnabled()) {
                // Suspended account: sendToUser wouldn't stop this, so gate it here.
                recipients.add(new RecipientResult(userId, Outcome.SKIPPED_DISABLED, PushFanout.EMPTY));
                skippedDisabled++;
                skipped++;
                continue;
            }
            if (!user.getNotificationPref().permitsPush()) {
                // Opted out of push (notificationPref is EMAIL / not PUSH|BOTH). First honour of the pref.
                recipients.add(new RecipientResult(userId, Outcome.SKIPPED_OPTED_OUT, PushFanout.EMPTY));
                skippedOptedOut++;
                skipped++;
                continue;
            }

            // Eligible: resolve this user's tokens (by the surrogate id we already have) and drop any
            // already sent to in this broadcast — the surplus is the dedupe count. What's left is this
            // recipient's own, not-already-sent tokens; the aggregate is the natural sum since each token
            // is delivered exactly once across the whole run.
            List<DeviceToken> devices = deviceTokens.findByUserId(user.getId());
            List<String> toSend = new ArrayList<>();
            for (DeviceToken device : devices) {
                String token = device.getToken();
                if (sentTokens.add(token)) {
                    toSend.add(token);
                } else {
                    dedupedTokens++; // shared with an earlier recipient — already handed to the sender
                }
            }

            // Only hit the sender when there's actually a not-already-sent token — a no-device user, or
            // one whose every token was already sent to (all shared), has nothing new to deliver.
            PushFanout fanout = toSend.isEmpty() ? PushFanout.EMPTY : push.sendToTokens(toSend, message);
            // A recipient with zero registered devices is NO_DEVICES; one whose every token was a
            // duplicate is still SENT (they were targeted, just via a token already counted).
            Outcome outcome = devices.isEmpty() ? Outcome.NO_DEVICES : Outcome.SENT;
            recipients.add(new RecipientResult(userId, outcome, fanout));

            if (outcome == Outcome.SENT) {
                sent++;
            } else {
                skipped++; // resolved + eligible but had no devices to deliver to
            }
            targeted += fanout.targeted();
            delivered += fanout.delivered();
            pruned += fanout.pruned();
            failed += fanout.failed();
        }

        BroadcastResult result = new BroadcastResult(
                userIds.size(),
                sent,
                skipped,
                targeted,
                delivered,
                pruned,
                failed,
                skippedOptedOut,
                skippedDisabled,
                skippedNotFound,
                dedupedTokens,
                recipients);

        record(actorUid, title, body, route, result);
        // Record the cooldown window only now the broadcast has actually completed.
        lastBroadcast.put(actorUid, now);
        return result;
    }

    /**
     * Persist the durable trace of a broadcast: one {@link NotificationBroadcast} header row and one
     * {@link AuditAction#BROADCAST_SENT} audit summary, both in the caller's transaction. Audit metadata
     * is counts/title/route only — never tokens. The skipped-by-rail + deduped counts are included so the
     * record answers "who did we intentionally NOT send to, and why".
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
                // Map.ofEntries (not Map.of): 11 entries exceeds Map.of's 10-pair overloads. Explicit
                // <String, Object> so the mixed Integer/String values widen to the metadata value type.
                Map.<String, Object>ofEntries(
                        Map.entry("recipientCount", result.requested()),
                        Map.entry("sent", result.sent()),
                        Map.entry("skipped", result.skipped()),
                        Map.entry("skippedOptedOut", result.skippedOptedOut()),
                        Map.entry("skippedDisabled", result.skippedDisabled()),
                        Map.entry("skippedNotFound", result.skippedNotFound()),
                        Map.entry("dedupedTokens", result.dedupedTokens()),
                        Map.entry("delivered", result.delivered()),
                        Map.entry("title", title),
                        Map.entry("route", route == null ? "" : route)));

        log.info(
                "Broadcast {} by {}: requested={}, sent={}, skipped={} (optedOut={}, disabled={}, "
                        + "notFound={}), deduped={}, targeted={}, delivered={}, pruned={}, failed={}",
                header.getId(),
                actorUid,
                result.requested(),
                result.sent(),
                result.skipped(),
                result.skippedOptedOut(),
                result.skippedDisabled(),
                result.skippedNotFound(),
                result.dedupedTokens(),
                result.targeted(),
                result.delivered(),
                result.pruned(),
                result.failed());
    }
}
