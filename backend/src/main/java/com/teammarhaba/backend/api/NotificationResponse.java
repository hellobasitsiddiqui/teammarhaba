package com.teammarhaba.backend.api;

import com.teammarhaba.backend.notify.Notification;
import com.teammarhaba.backend.notify.NotificationType;
import java.time.Instant;

/**
 * The wire shape of one persisted notification in the caller's feed (TM-454, group-notifications) —
 * the admin/system entries the bell + panel read back from the notification store ({@link
 * Notification}, TM-452). A DTO (never the JPA entity) so the HTTP contract is decoupled from the
 * mapping and stays reviewable in {@code openapi.json}.
 *
 * <p>{@code seen}/{@code read} are the derived booleans the UI actually renders against (a dot on
 * the bell, a bold/unbold row); the raw {@code seenAt}/{@code readAt} timestamps are carried too so
 * a client can show "seen 3m ago" without a second call. They mirror the entity's two read-model
 * timestamps: {@code seen == (seenAt != null)} and {@code read == (readAt != null)}.
 *
 * @param id        the notification's surrogate id (used by the mark-read route)
 * @param type      what kind of thing it tells the user about ({@link NotificationType})
 * @param title     short headline
 * @param body      the notification text
 * @param deepLink  optional in-app route it opens (e.g. {@code /events/42}); {@code null} if none
 * @param sourceRef optional opaque reference to the originating entity; {@code null} if none
 * @param sticky    pinned/exempt-from-purge (admin-send only) — surfaced so the UI can flag it
 * @param createdAt DB-authoritative creation instant (drives the newest-first feed order)
 * @param seenAt     when the caller last saw it in the panel; {@code null} while unseen
 * @param readAt     when the caller opened/read it; {@code null} while unread
 * @param seen       convenience: {@code seenAt != null} (does not count toward the bell badge)
 * @param read       convenience: {@code readAt != null} (does not count toward the unread count)
 * @param recalledAt when an admin recalled it (TM-473); {@code null} while live. Only an already-seen
 *                   admin message carries this — the HYBRID recall tombstones the seen copies and
 *                   deletes the unseen ones, so a recalled row is by definition one the caller had seen.
 * @param recalled   convenience: {@code recalledAt != null} — drives the panel's struck-through
 *                   "Recalled by admin · &lt;time&gt;" render for a tombstoned admin message
 */
public record NotificationResponse(
        Long id,
        NotificationType type,
        String title,
        String body,
        String deepLink,
        String sourceRef,
        boolean sticky,
        Instant createdAt,
        Instant seenAt,
        Instant readAt,
        boolean seen,
        boolean read,
        Instant recalledAt,
        boolean recalled) {

    /**
     * Map a persisted {@link Notification} to its wire form, deriving the {@code seen}/{@code read}/
     * {@code recalled} flags from their backing timestamps.
     */
    public static NotificationResponse from(Notification n) {
        return new NotificationResponse(
                n.getId(),
                n.getType(),
                n.getTitle(),
                n.getBody(),
                n.getDeepLink(),
                n.getSourceRef(),
                n.isSticky(),
                n.getCreatedAt(),
                n.getSeenAt(),
                n.getReadAt(),
                n.getSeenAt() != null,
                n.getReadAt() != null,
                n.getRecalledAt(),
                n.getRecalledAt() != null);
    }
}
