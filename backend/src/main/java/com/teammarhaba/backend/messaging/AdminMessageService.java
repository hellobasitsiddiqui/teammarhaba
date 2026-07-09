package com.teammarhaba.backend.messaging;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.notify.NotificationRepository;
import com.teammarhaba.backend.notify.NotificationType;
import com.teammarhaba.backend.notify.NotificationWriter;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushNotificationService;
import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
import com.teammarhaba.backend.notify.PushRoutes;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.BadRequestException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The admin send (TM-441, epic TM-432): an admin sends one message to a <em>resolved audience</em>
 * (a user / a city / one-or-more events' GOING attendees), and every recipient gets it durably in
 * their in-app inbox (bell + panel) plus a best-effort push. This is the first consumer of
 * {@link RecipientResolver} (TM-440) and wires the already-built {@code ADMIN_MESSAGE}
 * {@link NotificationWriter#writeAdminMessage writer} (TM-453).
 *
 * <p><strong>What one send does, in order (all in one transaction):</strong>
 *
 * <ol>
 *   <li><b>Validate the deep-link.</b> A non-null {@code deepLink} is checked against the stricter
 *       {@link PushRoutes#isKnown admin allow-list} up-front — an off-list route is a clean
 *       {@code 400} before anything is persisted or sent (mirrors {@code BroadcastService} /
 *       {@code UserAdminService.sendTestPush}). Length caps on title/body are the DTO's contract.
 *   <li><b>Resolve the audience.</b> {@link RecipientResolver#resolve} turns the {@link AudienceSpec}
 *       into the concrete, de-duplicated set of active account ids <em>as a snapshot now</em>
 *       (soft-deleted accounts already dropped). An empty resolution is a {@code 400} — a send to
 *       nobody is rejected here, exactly as the resolver's contract delegates that guard to the sender.
 *   <li><b>Create the campaign.</b> One immutable {@link AdminMessage} header row is appended (the
 *       "one thread per campaign" record the sent-history API, TM-442, reads back). Its id keys the
 *       per-recipient notifications ({@code source_ref = "admin_message:<id>"}).
 *   <li><b>Deliver durably (the inbox — one-way, push-pref-independent).</b>
 *       {@link NotificationWriter#writeAdminMessageInCurrentTransaction} writes one {@code ADMIN_MESSAGE}
 *       row per active recipient, <em>joining this transaction</em> so the durable rows share the send's
 *       atomicity — a later failure rolls them back with the header (TM-554), never stranding an orphan.
 *       This is <em>write-only</em>: a recipient can never post <em>into</em> an admin
 *       message — the channel is a notification, not a conversation, so one-way is structural, not a
 *       runtime check (and the endpoint itself is admin-gated, so a regular user can't send one
 *       either). The inbox is delivered to <em>every</em> active recipient regardless of push
 *       preference (an email-only user still reads their bell).
 *   <li><b>Fan out push (best-effort, opt-out-respecting).</b> On top of the durable inbox, a
 *       transient push is sent to the subset that opted into push — a suspended or push-opted-out
 *       account gets the inbox row but no push. A device token shared across recipients is pushed
 *       once. The push body is a {@link #pushPreview preview} of a possibly-long message; the full
 *       text lives in the durable inbox row (and the campaign header).
 *   <li><b>Audit.</b> One {@link AuditAction#ADMIN_MESSAGE_SENT} row records the target, recipient
 *       count and delivery counts — never the body or any device token.
 * </ol>
 *
 * <p><strong>Reuses, never rebuilds.</strong> Audience resolution is {@link RecipientResolver}, the
 * durable write is {@link NotificationWriter}, and the actual FCM fan-out is
 * {@link PushNotificationService#sendToTokens} (so token resolution, {@code UNREGISTERED}-pruning and
 * outcome classification stay inside the notify package). The opt-out / skip-disabled / shared-token
 * dedupe rails mirror {@code BroadcastService} (TM-364).
 */
@Service
public class AdminMessageService {

    private static final Logger log = LoggerFactory.getLogger(AdminMessageService.class);

    /** Audit {@code target_type} for an admin-message campaign — the kind of thing acted on. */
    private static final String TARGET_TYPE = "AdminMessage";

    /** {@code source_ref} prefix that ties each durable notification back to its campaign header. */
    static final String SOURCE_REF_PREFIX = "admin_message:";

    /**
     * Max chars of the message body carried in the transient push. The full body (up to ~5000 chars)
     * survives in the durable inbox row; a push is only a preview and an oversized FCM payload
     * (&gt;4KB) would be rejected outright, so the push shows the opening of the message and a tap
     * opens the full text in-app.
     */
    static final int PUSH_PREVIEW_LENGTH = 500;

    private final RecipientResolver recipientResolver;
    private final NotificationWriter notificationWriter;
    private final NotificationRepository notifications;
    private final PushNotificationService push;
    private final DeviceTokenRepository deviceTokens;
    private final UserRepository users;
    private final AdminMessageRepository adminMessages;
    private final AuditService audit;

    public AdminMessageService(
            RecipientResolver recipientResolver,
            NotificationWriter notificationWriter,
            NotificationRepository notifications,
            PushNotificationService push,
            DeviceTokenRepository deviceTokens,
            UserRepository users,
            AdminMessageRepository adminMessages,
            AuditService audit) {
        this.recipientResolver = recipientResolver;
        this.notificationWriter = notificationWriter;
        this.notifications = notifications;
        this.push = push;
        this.deviceTokens = deviceTokens;
        this.users = users;
        this.adminMessages = adminMessages;
        this.audit = audit;
    }

    /**
     * Send {@code title}/{@code body} (+ optional {@code deepLink}) to the audience described by
     * {@code spec}, on behalf of the admin {@code actorUid}. See the class doc for the full sequence.
     *
     * @param actorUid   Firebase UID of the admin sending the message (attribution; never null)
     * @param spec       the audience to resolve (one target type; validated at the API edge)
     * @param targetType which single dimension {@code spec} targets (persisted on the campaign header)
     * @param targetRef  a human-readable descriptor of the target for the sent-history view
     * @param title      the message headline (non-blank/bounded at the web edge)
     * @param body       the message body (non-blank/bounded at the web edge; up to ~5000 chars)
     * @param deepLink   an optional known deep-link route ({@code null} = none); an off-list route is a 400
     * @return the campaign id, target and delivery counts
     * @throws BadRequestException if {@code deepLink} is off-list, or the audience resolves to nobody
     */
    @Transactional
    public AdminSendResult send(
            String actorUid,
            AudienceSpec spec,
            TargetType targetType,
            String targetRef,
            String title,
            String body,
            String deepLink) {
        // 1. Validate the deep-link once, up-front — admin input against the stricter exact allow-list —
        // so an off-list route is a clean 400 BEFORE we resolve, persist or send anything.
        if (deepLink != null && !PushRoutes.isKnown(deepLink)) {
            throw new BadRequestException(
                    "Unknown deep-link route '" + deepLink + "'. Allowed: " + PushRoutes.KNOWN);
        }

        // 2. Resolve the audience to the concrete active-account snapshot. Empty = a send to nobody,
        // which the resolver's contract leaves for the sender to reject as a 400.
        Set<Long> recipients = recipientResolver.resolve(spec);
        if (recipients.isEmpty()) {
            throw new BadRequestException("This message resolved to no recipients.");
        }

        // 3. Append the immutable campaign header first, so its id keys the per-recipient notifications.
        AdminMessage campaign = adminMessages.save(
                new AdminMessage(actorUid, title, body, deepLink, targetType, targetRef, recipients.size()));
        String sourceRef = SOURCE_REF_PREFIX + campaign.getId();

        // 4. Durable inbox (one-way): one ADMIN_MESSAGE row per ACTIVE recipient, pref-independent.
        // The writer narrows to enabled, non-tombstoned accounts and is idempotent on (user, source_ref).
        // Crucially this JOINS the current transaction (writeAdminMessageInCurrentTransaction, REQUIRED),
        // so the inbox rows commit or roll back together with the header saved above and the audit recorded
        // below. A later failure — an audit DB error, or a fanOutPush read failing for a recipient — then
        // rolls the whole send back as one, so it can never strand orphaned notifications referencing a
        // campaign header that itself rolled back (TM-554).
        int notified = notificationWriter.writeAdminMessageInCurrentTransaction(
                recipients, title, body, deepLink, sourceRef, false);

        // 5. Best-effort push on top of the durable inbox, respecting the opt-out / skip-disabled rails.
        PushMessage pushMessage = new PushMessage(title, pushPreview(body), deepLink);
        PushTally tally = fanOutPush(recipients, pushMessage);

        // 6. One audit summary row — target + counts only, never the body or any device token.
        audit.record(
                actorUid,
                AuditAction.ADMIN_MESSAGE_SENT,
                TARGET_TYPE,
                String.valueOf(campaign.getId()),
                Map.<String, Object>ofEntries(
                        Map.entry("targetType", targetType.name()),
                        Map.entry("targetRef", targetRef),
                        Map.entry("recipientCount", recipients.size()),
                        Map.entry("notified", notified),
                        Map.entry("pushTargeted", tally.targeted),
                        Map.entry("pushDelivered", tally.delivered),
                        Map.entry("pushPruned", tally.pruned),
                        Map.entry("pushFailed", tally.failed),
                        Map.entry("pushSkipped", tally.skipped),
                        Map.entry("title", title),
                        Map.entry("route", deepLink == null ? "" : deepLink)));

        log.info(
                "Admin message {} by {}: target={}({}), recipients={}, notified={}, push[targeted={}, "
                        + "delivered={}, pruned={}, failed={}, skipped={}]",
                campaign.getId(),
                actorUid,
                targetType,
                targetRef,
                recipients.size(),
                notified,
                tally.targeted,
                tally.delivered,
                tally.pruned,
                tally.failed,
                tally.skipped);

        return new AdminSendResult(
                campaign.getId(),
                targetType,
                recipients.size(),
                notified,
                tally.targeted,
                tally.delivered,
                tally.pruned,
                tally.failed,
                tally.skipped);
    }

    /**
     * The calling admin's sent-message history (TM-442): their {@link AdminMessage} campaign headers,
     * in the order the {@code pageable} carries (the controller fixes it newest-first). Scoped by actor
     * — "what did <em>I</em> send" — so it reuses the by-actor finder and its {@code idx_admin_message_actor}
     * index, making each history page a single indexed read of the append-only header table (no new
     * migration; TM-441 owns the schema).
     *
     * <p>Read-only: the header table is append-only and this path never writes. Returns the JPA page;
     * the controller maps each header to its {@link com.teammarhaba.backend.api.AdminSentHistoryResponse}
     * wire form, so the entity never leaves the service boundary.
     *
     * @param actorUid Firebase UID of the admin whose sends to list (the verified caller)
     * @param pageable page/size/sort (the controller fixes newest-first; size is capped upstream)
     * @return a page of this admin's campaign headers in the requested order
     */
    @Transactional(readOnly = true)
    public Page<AdminMessage> sentHistory(String actorUid, Pageable pageable) {
        return adminMessages.findByActorUid(actorUid, pageable);
    }

    /**
     * Load one campaign the calling admin sent, by id (TM-562) — the by-id detail behind the sent-history
     * "open one to see the message body" story. Where {@link #sentHistory} projects header-only list rows,
     * this returns the whole {@link AdminMessage} header (which the controller maps to
     * {@link com.teammarhaba.backend.api.AdminMessageDetailResponse}, <em>including</em> its {@code body}),
     * so the expanded row can finally render the actual text that was sent.
     *
     * <p><b>Sender-scoped 404.</b> The campaign is loaded <em>scoped to the caller</em> via
     * {@link AdminMessageRepository#findByIdAndActorUid} — the SAME rule as recall and the sent-history
     * list ("messages <em>I</em> sent") — so an unknown id AND another admin's message both resolve to a
     * uniform {@code 404} ({@link ResourceNotFoundException}), never leaking that a campaign the caller
     * didn't send exists. Admin-gating (non-admin {@code 403}, anonymous {@code 401}) is the controller's
     * class {@code @PreAuthorize}. Read-only: the header table is append-only and this path never writes.
     *
     * @param actorUid  Firebase UID of the admin whose campaign to load (the verified caller)
     * @param messageId the campaign id to fetch
     * @return the campaign header (including its body) for the caller's own send
     * @throws ResourceNotFoundException if no campaign with that id was sent by this admin
     */
    @Transactional(readOnly = true)
    public AdminMessage detail(String actorUid, long messageId) {
        return adminMessages
                .findByIdAndActorUid(messageId, actorUid)
                .orElseThrow(() -> new ResourceNotFoundException("No message " + messageId + "."));
    }

    /**
     * Recall (unsend) a message the calling admin previously sent (TM-473). In one transaction:
     *
     * <ol>
     *   <li><b>Scope + exist.</b> The campaign is loaded by id <em>scoped to the caller</em>
     *       ({@link AdminMessageRepository#findByIdAndActorUid}); an unknown id OR another admin's
     *       message is a uniform {@code 404} ({@link ResourceNotFoundException}), so recall never leaks
     *       a campaign the caller didn't send (same 404-not-403 rule as the sent-history read).
     *   <li><b>Mark recalled.</b> {@link AdminMessage#markRecalled} stamps the header's one-way
     *       {@code recalledAt}/{@code recalledBy}; the sent-history view then shows it {@code RECALLED}.
     *       Idempotent: recalling an already-recalled message is a no-op that removes nothing and does
     *       not re-audit (returns {@code removed = 0, tombstoned = 0} with the original recall stamp).
     *   <li><b>Partition the in-app copies (HYBRID recall — the owner's design decision, TM-473).</b>
     *       The durable {@code ADMIN_MESSAGE} rows this campaign created ({@code source_ref =
     *       'admin_message:<id>'}) are split by whether the recipient has <em>seen</em> them — i.e.
     *       viewed the bell/panel that contained them ({@code seen_at}), NOT whether they opened/read
     *       the item:
     *       <ul>
     *         <li><b>Unseen</b> ({@code seen_at is null}) → <b>deleted</b>
     *             ({@link NotificationRepository#deleteUnseenByTypeAndSourceRef}): a clean vanish with no
     *             trace — the recipient never knew it existed — which also clears the unseen bell count
     *             those rows drive (inbox and bell are the same store).
     *         <li><b>Seen</b> ({@code seen_at is not null}) → <b>tombstoned</b>
     *             ({@link NotificationRepository#markRecalledSeenByTypeAndSourceRef}): the row is kept and
     *             stamped {@code recalled_at}, so the feed API surfaces it recalled and the panel renders
     *             it struck-through with "Recalled by admin · &lt;time&gt;". We don't silently vanish
     *             something the recipient already looked at.
     *       </ul>
     *       Both partitions use the same recall {@link Instant} the header was stamped with, so the
     *       header and every tombstone share one recall moment.
     *   <li><b>Audit.</b> One {@link AuditAction#ADMIN_MESSAGE_RECALLED} row records the campaign id and
     *       how many copies were removed vs tombstoned — never the body.
     * </ol>
     *
     * <p><b>Best-effort on push (documented limit).</b> Recall removes only the durable IN-APP copies. A
     * push that already fired to a recipient's OS notification tray is fire-and-forget and cannot be
     * un-sent — there is no FCM "recall" — so a tray push may linger until the OS/user clears it; tapping
     * it just opens the (now-removed) in-app item. This is the honest boundary of recall and is surfaced
     * in the API/UI copy (see {@code AdminMessageRecallResponse} / {@code admin-message-recall-core.js}).
     *
     * @param actorUid  Firebase UID of the admin recalling the message (the verified caller)
     * @param messageId the campaign id to recall
     * @return the recall outcome (campaign id, recall stamp, unseen rows removed + seen rows tombstoned)
     * @throws ResourceNotFoundException if no campaign with that id was sent by this admin
     */
    @Transactional
    public AdminRecallResult recall(String actorUid, long messageId) {
        AdminMessage campaign = adminMessages
                .findByIdAndActorUid(messageId, actorUid)
                .orElseThrow(() -> new ResourceNotFoundException("No message " + messageId + " to recall."));

        // One recall moment shared by the header stamp and every seen-row tombstone below.
        Instant recalledAt = Instant.now();

        // Idempotent: an already-recalled campaign returns its recorded recall, changing nothing and not
        // re-auditing — a double-tap / retried recall can't double-count or write a second audit row.
        if (!campaign.markRecalled(actorUid, recalledAt)) {
            return new AdminRecallResult(
                    campaign.getId(), campaign.getRecalledAt(), campaign.getRecalledBy(), 0, 0);
        }

        // HYBRID recall of the durable in-app copies this campaign created (see the method javadoc):
        //   • UNSEEN rows (never surfaced in the recipient's bell/panel) → DELETED (clean vanish); this
        //     also clears the unseen bell count they drive (inbox and bell are the same store).
        //   • SEEN rows (the recipient already viewed the bell/panel containing them) → TOMBSTONED:
        //     kept and stamped recalled, so the panel shows them struck-through as "Recalled by admin".
        // Best-effort on push: an OS-tray push already delivered can't be un-sent (no FCM recall); only
        // the in-app copies are touched.
        String sourceRef = SOURCE_REF_PREFIX + campaign.getId();
        int removed = notifications.deleteUnseenByTypeAndSourceRef(NotificationType.ADMIN_MESSAGE, sourceRef);
        int tombstoned =
                notifications.markRecalledSeenByTypeAndSourceRef(NotificationType.ADMIN_MESSAGE, sourceRef, recalledAt);

        audit.record(
                actorUid,
                AuditAction.ADMIN_MESSAGE_RECALLED,
                TARGET_TYPE,
                String.valueOf(campaign.getId()),
                Map.<String, Object>of("removed", removed, "tombstoned", tombstoned));

        log.info(
                "Admin message {} recalled by {}: removed {} unseen + tombstoned {} seen in-app copies "
                        + "(push already delivered is best-effort)",
                campaign.getId(),
                actorUid,
                removed,
                tombstoned);

        return new AdminRecallResult(
                campaign.getId(), campaign.getRecalledAt(), campaign.getRecalledBy(), removed, tombstoned);
    }

    /**
     * Fan the transient push out to the opted-in subset of {@code recipients}, de-duplicating a device
     * token shared across recipients so it is pushed exactly once. Recipients are re-loaded through
     * {@link UserRepository} (the {@code @SQLRestriction} keeps this active-only) so the opt-out and
     * skip-disabled gates can be applied — a suspended or push-opted-out account got the durable inbox
     * row but gets no push. A recipient with no registered device is not a push skip (they are reachable,
     * just have nothing to push to); a gated recipient is.
     */
    private PushTally fanOutPush(Set<Long> recipients, PushMessage pushMessage) {
        // One batch read of the recipient accounts, keyed by id (soft-deleted rows already excluded by
        // the resolver AND by the entity's @SQLRestriction, so a missing id here is a gated skip).
        Map<Long, User> byId = users.findAllById(recipients).stream()
                .collect(Collectors.toMap(User::getId, Function.identity()));

        // Tokens already handed to the sender in THIS send, so a device shared across two recipients is
        // pushed once, not twice. Insertion-ordered for stable, reviewable behaviour.
        Set<String> sentTokens = new LinkedHashSet<>();
        int targeted = 0;
        int delivered = 0;
        int pruned = 0;
        int failed = 0;
        int skipped = 0;

        for (Long userId : recipients) {
            User user = byId.get(userId);
            if (user == null || !user.isEnabled() || !user.getNotificationPref().permitsPush()) {
                // Suspended, soft-deleted or opted out of push: durable inbox reached them, push does not.
                skipped++;
                continue;
            }

            // Resolve this user's tokens and drop any already sent to in this send — the dedupe. What's
            // left is delivered exactly once, so the aggregate is the natural sum across recipients.
            List<String> toSend = new ArrayList<>();
            for (DeviceToken device : deviceTokens.findByUserId(userId)) {
                if (sentTokens.add(device.getToken())) {
                    toSend.add(device.getToken());
                }
            }
            if (toSend.isEmpty()) {
                continue; // opted in, but no (not-already-sent) device to deliver to
            }
            PushFanout fanout = push.sendToTokens(toSend, pushMessage);
            targeted += fanout.targeted();
            delivered += fanout.delivered();
            pruned += fanout.pruned();
            failed += fanout.failed();
        }
        return new PushTally(targeted, delivered, pruned, failed, skipped);
    }

    /**
     * The body carried in the transient push: the whole body if short enough, otherwise its first
     * {@link #PUSH_PREVIEW_LENGTH} chars with a trailing ellipsis. The durable inbox row keeps the full
     * text — this only bounds the push so a long admin message can't exceed FCM's payload limit.
     */
    static String pushPreview(String body) {
        if (body.length() <= PUSH_PREVIEW_LENGTH) {
            return body;
        }
        return body.substring(0, PUSH_PREVIEW_LENGTH - 1).stripTrailing() + "…";
    }

    /** Mutable-free tally of the push fan-out across all recipients (never leaves this class). */
    private record PushTally(int targeted, int delivered, int pruned, int failed, int skipped) {}
}
