package com.teammarhaba.backend.notify;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import org.hibernate.annotations.Generated;
import org.hibernate.generator.EventType;

/**
 * One persisted notification in a user's inbox (TM-452, group-notifications). This is the durable
 * record that lets an admin/system notification SURVIVE beyond a transient push (the TM-374 gap): a
 * push is fire-and-forget, but a row here is what the bell + panel read back and what the unseen/
 * unread counts are computed from.
 *
 * <p>Schema is owned by Flyway ({@code V21__create_notifications}); Hibernate runs validate-only, so
 * this mapping must match the table exactly. {@code createdAt} is DB-authoritative ({@code default
 * now()}) and read back after insert, so the feed's newest-first order can't be caller-skewed.
 *
 * <p>Stored against {@code user_id} (the {@code users.id} surrogate) with {@code ON DELETE CASCADE}
 * and kept as a plain FK id rather than a JPA association — same convention as {@link
 * com.teammarhaba.backend.device.DeviceToken} and {@code EventAttendance} — to stay decoupled from
 * the {@code User} aggregate's soft-delete {@code @SQLRestriction}.
 *
 * <p><b>Mutable state is only the two read-model timestamps.</b> Everything about what the
 * notification <em>is</em> (type/title/body/deep-link/source/sticky) is set once at construction and
 * has no setter; the only transitions are {@link #markSeen(Instant)} (bell badge) and {@link
 * #markRead(Instant)} (unread count), each a one-way, idempotent set-if-null so a re-mark never
 * rewrites the original timestamp.
 *
 * <p>{@code sticky} is exposed but not settable here: only the admin-send path (TM-441 / TM-453) may
 * construct a sticky notification, and the retention purge keeps the last 50 non-sticky per user
 * plus all sticky ones (see {@link NotificationRepository}).
 */
@Entity
@Table(name = "notification")
public class Notification {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false, updatable = false)
    private Long userId;

    @Enumerated(EnumType.STRING)
    @Column(name = "type", nullable = false, updatable = false)
    private NotificationType type;

    @Column(name = "title", nullable = false, updatable = false)
    private String title;

    @Column(name = "body", nullable = false, updatable = false)
    private String body;

    /** Optional in-app route the notification opens (e.g. {@code /events/42}); {@code null} if none. */
    @Column(name = "deep_link", updatable = false)
    private String deepLink;

    /** Optional opaque reference to the originating entity (event / message id); {@code null} if none. */
    @Column(name = "source_ref", updatable = false)
    private String sourceRef;

    /** Pinned/exempt-from-purge flag; only the admin-send path may set it. Immutable once created. */
    @Column(name = "sticky", nullable = false, updatable = false)
    private boolean sticky;

    /** DB-authoritative ({@code default now()}); generated on insert and read back. */
    @Generated(event = EventType.INSERT)
    @Column(name = "created_at", nullable = false, insertable = false, updatable = false)
    private Instant createdAt;

    /** When the user last saw it in the panel; {@code null} = unseen (drives the bell badge). */
    @Column(name = "seen_at")
    private Instant seenAt;

    /** When the user opened/read it; {@code null} = unread (drives the unread count). */
    @Column(name = "read_at")
    private Instant readAt;

    /**
     * When this notification was recalled by an admin (TM-473); {@code null} = live. The tombstone
     * marker for the HYBRID admin-message recall: an already-SEEN row is kept and stamped here (rather
     * than deleted) so the panel renders it struck-through with "Recalled by admin · &lt;time&gt;" —
     * don't silently vanish something the recipient already looked at. Unseen rows are deleted at
     * recall, not stamped, so they never carry this. Set once via {@link #markRecalled(Instant)} and
     * never rewritten (one-way set-if-null, like {@link #seenAt}/{@link #readAt}). Owned by Flyway
     * ({@code V26__notification_recalled}).
     */
    @Column(name = "recalled_at")
    private Instant recalledAt;

    /** Required by JPA. */
    protected Notification() {
    }

    /**
     * A non-sticky notification — the ordinary system/writer path. {@code createdAt} is DB-generated;
     * {@code seenAt}/{@code readAt} start {@code null} (unseen + unread).
     */
    public Notification(
            Long userId, NotificationType type, String title, String body, String deepLink, String sourceRef) {
        this(userId, type, title, body, deepLink, sourceRef, false);
    }

    /**
     * Full constructor including {@code sticky} — reserved for the admin-send path (TM-441 / TM-453),
     * the only caller allowed to pin a notification.
     */
    public Notification(
            Long userId,
            NotificationType type,
            String title,
            String body,
            String deepLink,
            String sourceRef,
            boolean sticky) {
        this.userId = userId;
        this.type = type;
        this.title = title;
        this.body = body;
        this.deepLink = deepLink;
        this.sourceRef = sourceRef;
        this.sticky = sticky;
    }

    /**
     * Mark the notification seen in the panel (bell badge clears). One-way and idempotent: the first
     * call stamps {@code seenAt}; later calls are a no-op so the original moment is preserved.
     */
    public void markSeen(Instant when) {
        if (this.seenAt == null) {
            this.seenAt = when;
        }
    }

    /**
     * Mark the notification read (unread count drops). One-way and idempotent, like {@link
     * #markSeen(Instant)}. Reading also implies it was seen, so this back-fills {@code seenAt} if the
     * row was opened without a prior panel-view.
     */
    public void markRead(Instant when) {
        markSeen(when);
        if (this.readAt == null) {
            this.readAt = when;
        }
    }

    /**
     * Tombstone this notification as recalled by an admin (TM-473) — the SEEN half of the HYBRID
     * recall. One-way and idempotent, like {@link #markSeen(Instant)}: the first call stamps {@code
     * recalledAt}; a later call is a no-op so the original recall moment is preserved. Only the
     * already-seen rows of a recalled campaign are stamped (the unseen ones are deleted, never reach
     * here); the caller ({@code AdminMessageService.recall} / the repository bulk update) owns which
     * rows this applies to. Kept for symmetry with the entity's other read-model transitions; the
     * recall path uses the repository bulk update for the fan-out, but a per-row caller/test can use
     * this.
     *
     * @param when the recall timestamp
     * @return {@code true} if this call performed the recall (was live), {@code false} if already recalled
     */
    public boolean markRecalled(Instant when) {
        if (this.recalledAt != null) {
            return false;
        }
        this.recalledAt = when;
        return true;
    }

    public Long getId() {
        return id;
    }

    public Long getUserId() {
        return userId;
    }

    public NotificationType getType() {
        return type;
    }

    public String getTitle() {
        return title;
    }

    public String getBody() {
        return body;
    }

    public String getDeepLink() {
        return deepLink;
    }

    public String getSourceRef() {
        return sourceRef;
    }

    public boolean isSticky() {
        return sticky;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getSeenAt() {
        return seenAt;
    }

    public Instant getReadAt() {
        return readAt;
    }

    /** When this notification was recalled by an admin, or {@code null} if it is still live (TM-473). */
    public Instant getRecalledAt() {
        return recalledAt;
    }

    /** Whether this notification has been recalled (the tombstone the feed/panel render struck-through). */
    public boolean isRecalled() {
        return recalledAt != null;
    }
}
