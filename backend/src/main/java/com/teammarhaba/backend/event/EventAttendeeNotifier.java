package com.teammarhaba.backend.event;

import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushNotificationService;
import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.stereotype.Component;

/**
 * Fan a single push out to a set of event attendees, resolved by {@code users.id} (TM-397). The
 * shared recipient primitive behind every event-notification path this ticket adds — the waitlist
 * offer cascade, the edit/cancel lifecycle pushes, and the claimant's "You're in ✓" confirmation.
 *
 * <p><b>The rails</b> are exactly the reminder fan-out's (TM-394) and the admin broadcast's
 * (TM-364), just keyed by user id instead of an attendance query so a caller can target GOING
 * attendees, a slice of the waitlist, or one claimant through the same seam:
 *
 * <ul>
 *   <li>people are resolved <em>through</em> {@link UserRepository} in one batch read, so a
 *       soft-deleted/tombstoned account (its attendance + device rows survive) is dropped by the
 *       entity's {@code @SQLRestriction} and never targeted;</li>
 *   <li>a suspended account ({@code enabled == false}) is skipped;</li>
 *   <li>{@code notificationPref} is honoured exactly like broadcast — only {@code PUSH}/{@code BOTH}
 *       receive; {@code EMAIL} (the default) <em>is</em> the push opt-out;</li>
 *   <li>device tokens are de-duplicated by value across the recipients (a shared/handed-down device
 *       is pushed once), insertion-ordered for stable behaviour, and delivered through the shared
 *       {@link PushNotificationService#sendToTokens} seam so FCM handling, {@code UNREGISTERED}
 *       pruning and outcome classification stay in one place.</li>
 * </ul>
 *
 * <p>Kept intentionally free of any transaction: it only reads (users, tokens) and then fans out —
 * the caller decides whether a surrounding transaction is needed (the cascade commits its offer
 * stamps first and calls this after; the lifecycle listener runs post-commit). An empty recipient
 * set, or one that resolves to no eligible device, is a no-op returning a zero fan-out.
 */
@Component
public class EventAttendeeNotifier {

    private final UserRepository users;
    private final DeviceTokenRepository deviceTokens;
    private final PushNotificationService push;

    public EventAttendeeNotifier(
            UserRepository users, DeviceTokenRepository deviceTokens, PushNotificationService push) {
        this.users = users;
        this.deviceTokens = deviceTokens;
        this.push = push;
    }

    /**
     * Push {@code message} to every eligible device of the given {@code userIds}, applying the rails
     * above. {@code userIds} is iterated in the order given (de-dup and eligibility are applied as we
     * walk), so callers that care about token ordering — e.g. a FIFO waitlist slice — get it.
     *
     * @return the fan-out outcome (zero when nobody is eligible or has a device)
     */
    public PushFanout pushToUsers(Collection<Long> userIds, PushMessage message) {
        if (userIds.isEmpty()) {
            return new PushFanout(0, 0, 0, 0);
        }
        // Resolve people THROUGH the User aggregate (one batch read): tombstoned accounts simply
        // aren't returned even though their attendance/device rows survive.
        Map<Long, User> byId = users.findAllById(userIds).stream()
                .collect(Collectors.toMap(User::getId, Function.identity()));

        // The eligible recipients, in the caller's order (the TM-364 rails: found + not soft-deleted,
        // enabled, and opted into push). Ineligible users' tokens are never even read.
        List<Long> eligible = new ArrayList<>();
        for (Long userId : userIds) {
            User user = byId.get(userId);
            if (user == null || !user.isEnabled() || !isPushEligible(user.getNotificationPref())) {
                continue; // not found/soft-deleted, suspended, or opted out of push — the TM-364 rails
            }
            eligible.add(userId);
        }
        if (eligible.isEmpty()) {
            return new PushFanout(0, 0, 0, 0);
        }

        // One batched token read for ALL eligible recipients (TM-525: was an N+1 findByUserId per user),
        // grouped by owner so we can still walk in the caller's order and keep the token de-dup stable.
        Map<Long, List<DeviceToken>> tokensByUser =
                deviceTokens.findByUserIdIn(eligible).stream().collect(Collectors.groupingBy(DeviceToken::getUserId));

        Set<String> tokens = new LinkedHashSet<>();
        for (Long userId : eligible) {
            for (DeviceToken device : tokensByUser.getOrDefault(userId, List.of())) {
                tokens.add(device.getToken());
            }
        }
        if (tokens.isEmpty()) {
            return new PushFanout(0, 0, 0, 0);
        }
        return push.sendToTokens(tokens, message);
    }

    /** Convenience for a single recipient (the claim confirmation). */
    public PushFanout pushToUser(long userId, PushMessage message) {
        return pushToUsers(List.of(userId), message);
    }

    /** Push-eligible == the pref opted into push; EMAIL (the default) is the opt-out — as broadcast. */
    private static boolean isPushEligible(NotificationPref pref) {
        return pref == NotificationPref.PUSH || pref == NotificationPref.BOTH;
    }
}
