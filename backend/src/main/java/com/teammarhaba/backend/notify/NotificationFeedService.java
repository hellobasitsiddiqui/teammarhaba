package com.teammarhaba.backend.notify;

import com.teammarhaba.backend.api.NotificationBadge;
import com.teammarhaba.backend.api.NotificationResponse;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Instant;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Reads and clears the caller's notification feed (TM-454) — the service behind {@code
 * /api/v1/me/notifications}. It sits directly on the notification store ({@link NotificationRepository},
 * TM-452): the durable admin/system inbox the bell + panel read back, independent of who wrote the
 * rows (the writer paths, TM-441 / TM-453, build in parallel and are not depended on here).
 *
 * <p><b>Identity is always the verified caller.</b> Every method resolves the notification owner from
 * the {@link VerifiedUser} principal via {@link UserService#provision} — the same just-in-time
 * provisioning the rest of the {@code /me} surface uses (a brand-new account simply has an empty
 * feed) — never from a client-supplied id, so a caller can only ever read or clear their own inbox.
 *
 * <p><b>Two clearing verbs, mirroring the store's two read-model timestamps:</b>
 * <ul>
 *   <li>{@link #markAllSeen} — the bulk "opening the bell clears the badge" action: stamps every
 *       unseen row seen and returns the fresh (now zero-unseen) {@link NotificationBadge}.
 *   <li>{@link #markRead} — the per-item "tapped it" action: one-way marks a single owned
 *       notification read (which back-fills seen), or {@code 404}s if it isn't the caller's.
 * </ul>
 */
@Service
public class NotificationFeedService {

    private final NotificationRepository notifications;
    private final UserService users;

    public NotificationFeedService(NotificationRepository notifications, UserService users) {
        this.notifications = notifications;
        this.users = users;
    }

    /**
     * The caller's feed as a page of DTOs, in the order the {@code pageable} carries (the controller
     * fixes it to newest-first). Provisioned rather than read-only because first-sight provisioning
     * may insert the account row; an existing user just reads their inbox.
     */
    @Transactional
    public PageResponse<NotificationResponse> feed(VerifiedUser caller, Pageable pageable) {
        Long userId = users.provision(caller).getId();
        return PageResponse.from(notifications.findByUserId(userId, pageable), NotificationResponse::from);
    }

    /** The caller's bell counts (unseen = badge, unread = per-item), computed straight from the store. */
    @Transactional
    public NotificationBadge badge(VerifiedUser caller) {
        Long userId = users.provision(caller).getId();
        return badgeFor(userId);
    }

    /**
     * Clear the bell badge: mark all of the caller's unseen notifications seen (idempotent — a
     * repeat call stamps nothing) and return the refreshed counts, so the client can update the bell
     * from the response without a follow-up {@code GET}. {@code unseen} in the result is therefore
     * {@code 0}; {@code unread} is unchanged (seeing the list isn't reading the items).
     */
    @Transactional
    public NotificationBadge markAllSeen(VerifiedUser caller) {
        Long userId = users.provision(caller).getId();
        notifications.markAllSeenForUser(userId, Instant.now());
        return badgeFor(userId);
    }

    /**
     * Mark one of the caller's notifications read on tap (TM-454). One-way and idempotent via {@link
     * Notification#markRead(Instant)} — reading also back-fills {@code seenAt} — and owner-scoped: a
     * notification that doesn't belong to the caller (or doesn't exist) is a {@code 404}, so ids
     * can't be probed across accounts. Returns the updated row so the client can re-render it.
     */
    @Transactional
    public NotificationResponse markRead(VerifiedUser caller, Long id) {
        Long userId = users.provision(caller).getId();
        Notification notification = notifications
                .findById(id)
                .filter(n -> n.getUserId().equals(userId))
                .orElseThrow(() -> new ResourceNotFoundException("Notification not found: " + id));
        notification.markRead(Instant.now()); // one-way, idempotent; dirty-checking flushes on commit
        return NotificationResponse.from(notifications.save(notification));
    }

    /** The current unseen (bell badge) + unread counts for a resolved user id. */
    private NotificationBadge badgeFor(Long userId) {
        return new NotificationBadge(
                notifications.countByUserIdAndSeenAtIsNull(userId),
                notifications.countByUserIdAndReadAtIsNull(userId));
    }
}
