package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.notify.NotificationFeedService;
import java.util.Set;
import org.springframework.data.domain.Sort;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The caller's notification feed under {@code /api/v1/me/notifications} (TM-454; the {@code /api/v1}
 * prefix is applied by {@link ApiV1Config}). This is the admin/system half of the bell — it reads the
 * durable notification store (TM-452); the chat-unread half rides the conversation model (TM-435 /
 * TM-436) and is delivered by the sibling notifications ticket, so a client sums the two.
 *
 * <p>Every route requires a signed-in caller — an anonymous/invalid token gets the uniform RFC 7807
 * {@code 401} from the security chain (default-deny). Identity comes from the verified {@link
 * VerifiedUser} principal, never the client, so a caller can only ever touch their own inbox.
 *
 * <ul>
 *   <li>{@code GET /me/notifications} — the feed, newest-first, paged via the shared list convention.
 *       Order is fixed (only {@code page}/{@code size} are caller-tunable).</li>
 *   <li>{@code GET /me/notifications/badge} — the bell counts: {@code unseen} (the badge) and
 *       {@code unread}.</li>
 *   <li>{@code POST /me/notifications/seen} — opening the bell: mark all unseen seen; returns the
 *       refreshed (now zero-unseen) counts.</li>
 *   <li>{@code POST /me/notifications/{id}/read} — tapping an item: one-way mark it read (a foreign or
 *       unknown id is a {@code 404}); returns the updated notification.</li>
 * </ul>
 */
@RestController
public class NotificationController {

    /**
     * The feed order the AC fixes: newest-first, with {@code id} as a deterministic same-{@code
     * createdAt} tiebreak — the same order as the store's {@code List} finder. The endpoint exposes no
     * {@code sort} param (the {@code list} handler binds only {@code page}/{@code size}, no {@code
     * Pageable}), so the order is not caller-overridable: an unknown query param such as {@code
     * ?sort=createdAt,asc} is simply ignored (the request still {@code 200}s with this fixed
     * newest-first order), never a {@code 400}.
     */
    private static final Sort NEWEST_FIRST = Sort.by(Sort.Order.desc("createdAt"), Sort.Order.desc("id"));

    private final NotificationFeedService notifications;

    NotificationController(NotificationFeedService notifications) {
        this.notifications = notifications;
    }

    /** The caller's notification feed, newest-first. Only {@code page}/{@code size} are tunable. */
    @GetMapping("/me/notifications")
    PageResponse<NotificationResponse> list(
            @AuthenticationPrincipal VerifiedUser caller,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size) {
        return notifications.feed(caller, PageRequests.of(page, size, null, Set.of(), NEWEST_FIRST));
    }

    /** The bell counts for the caller: {@code unseen} (badge) and {@code unread}. */
    @GetMapping("/me/notifications/badge")
    NotificationBadge badge(@AuthenticationPrincipal VerifiedUser caller) {
        return notifications.badge(caller);
    }

    /** Opening the bell — mark all unseen seen; returns the refreshed (zero-unseen) counts. */
    @PostMapping("/me/notifications/seen")
    NotificationBadge markSeen(@AuthenticationPrincipal VerifiedUser caller) {
        return notifications.markAllSeen(caller);
    }

    /** Tapping an item — one-way mark it read (foreign/unknown id → {@code 404}); returns it updated. */
    @PostMapping("/me/notifications/{id}/read")
    NotificationResponse markRead(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return notifications.markRead(caller, id);
    }
}
