package com.teammarhaba.backend.notify;

import java.time.Instant;
import java.util.List;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Data access for {@link Notification} (TM-452) — the user's inbox behind the bell + panel.
 *
 * <p>The three reads the UI needs: {@link #findByUserIdOrderByCreatedAtDescIdDesc(Long)} is the feed
 * (newest-first, with {@code id} as the deterministic same-instant tiebreak),
 * {@link #countByUserIdAndSeenAtIsNull(Long)} is the unseen bell badge, and
 * {@link #countByUserIdAndReadAtIsNull(Long)} is the unread count. All three are served by the two
 * indexes the migration adds ({@code (user_id, created_at DESC)} and {@code (user_id, seen_at)}).
 *
 * <p><b>Retention (locked, TM-452):</b> a user keeps their last {@link #RETAIN_PER_USER} <em>non</em>-
 * sticky notifications; <b>sticky</b> ones are exempt and kept regardless. A writer calls
 * {@link #purgeForUser(Long)} right after inserting so the inbox is trimmed continuously rather than
 * by a sweep. Sticky can only be set on the admin-send path (TM-441 / TM-453); this repo never sets
 * it — it only honours it in the purge.
 */
public interface NotificationRepository extends JpaRepository<Notification, Long> {

    /** How many non-sticky notifications a user keeps; sticky ones are exempt (kept regardless). */
    int RETAIN_PER_USER = 50;

    /** The user's feed, newest-first ({@code id} breaks a same-{@code createdAt} tie deterministically). */
    List<Notification> findByUserIdOrderByCreatedAtDescIdDesc(Long userId);

    /**
     * The user's feed as a bounded {@link Page} — what the feed API (TM-454) serves. The caller-supplied
     * {@link Pageable} carries the (fixed, newest-first) sort and the page window; the same
     * {@code (user_id, created_at DESC)} index that backs the {@code List} finder serves this too.
     */
    Page<Notification> findByUserId(Long userId, Pageable pageable);

    /** Unseen count for the bell badge ({@code seen_at is null}). */
    long countByUserIdAndSeenAtIsNull(Long userId);

    /** Unread count ({@code read_at is null}). */
    long countByUserIdAndReadAtIsNull(Long userId);

    /**
     * Mark <em>every</em> currently-unseen notification for the user as seen in one write — the
     * bulk "opening the bell clears the badge" transition (TM-454). Returns the number of rows
     * stamped. Scoped to {@code seen_at is null} so it only ever <b>sets</b> the timestamp on
     * unseen rows and never rewrites an already-seen one, preserving the same one-way, first-moment-
     * wins semantics as {@link Notification#markSeen(java.time.Instant)}. A single bulk update rather
     * than a load-mutate-save loop so the whole panel clears with one statement. Requires an active
     * transaction (the feed service provides one).
     */
    @Modifying
    @Query("update Notification n set n.seenAt = :seenAt where n.userId = :userId and n.seenAt is null")
    int markAllSeenForUser(@Param("userId") Long userId, @Param("seenAt") Instant seenAt);

    /**
     * Whether a notification already exists for this user, type and source-event key — the idempotency
     * probe the writers ({@link NotificationWriter}, TM-453) use to guarantee "no duplicate per source
     * event". {@code sourceRef} encodes the originating event uniquely (e.g. {@code event:42:updated:v7},
     * {@code event:42:reminder:T_MINUS_1H}), so a re-fired listener or a redelivered/ retried source
     * event never writes a second inbox row for the same person.
     */
    boolean existsByUserIdAndTypeAndSourceRef(Long userId, NotificationType type, String sourceRef);

    /**
     * Trim a user's inbox to the retention policy: delete their non-sticky notifications beyond the
     * newest {@code keep}, leaving <em>every</em> sticky one untouched. Returns the number of rows
     * removed. Native SQL because the keep-window is an ordered {@code LIMIT} subselect on the same
     * table (not expressible as a derived-query delete). Requires an active transaction (the writer's
     * service provides one). Prefer {@link #purgeForUser(Long)} in production — it pins {@code keep}
     * to the locked {@link #RETAIN_PER_USER}; the {@code keep} parameter exists so tests can exercise
     * the boundary with a small cap.
     */
    @Modifying
    @Query(
            value =
                    """
                    DELETE FROM notification n
                    WHERE n.user_id = :userId
                      AND n.sticky = false
                      AND n.id NOT IN (
                          SELECT n2.id FROM notification n2
                          WHERE n2.user_id = :userId AND n2.sticky = false
                          ORDER BY n2.created_at DESC, n2.id DESC
                          LIMIT :keep
                      )
                    """,
            nativeQuery = true)
    int purgeNonStickyBeyondCapForUser(@Param("userId") Long userId, @Param("keep") int keep);

    /**
     * Apply the locked retention policy: keep the last {@link #RETAIN_PER_USER} non-sticky
     * notifications for the user (all sticky ones exempt). What writers call after each insert.
     */
    default int purgeForUser(Long userId) {
        return purgeNonStickyBeyondCapForUser(userId, RETAIN_PER_USER);
    }

    /**
     * The <b>delete</b> half of the HYBRID admin-message <b>recall</b> (TM-473): delete every
     * <em>UNSEEN</em> notification a single campaign produced. An admin send writes one {@code
     * ADMIN_MESSAGE} row per recipient, all cross-linked by {@code source_ref = 'admin_message:<id>'};
     * recall removes the rows the recipient <em>never saw</em> ({@code seen_at is null} — never
     * surfaced in the bell/panel) in one statement, so for those recipients the message vanishes
     * cleanly with no trace (and the unseen bell count they drive drops too — inbox and bell are the
     * same store since TM-452/TM-453). The already-seen rows are NOT deleted here — they are tombstoned
     * by {@link #markRecalledSeenByTypeAndSourceRef} so the recipient sees a struck-through "Recalled by
     * admin" instead of a silent disappearance.
     *
     * <p>Scoped by {@code type} as well as {@code sourceRef} so it can only ever remove admin-message
     * rows, never a system notification that happened to share a ref. Returns the number of rows
     * removed (the delete-partition reach). Bulk delete (not a load-then-delete loop) so a large
     * fan-out is one round-trip; requires an active transaction (the recall service provides one).
     */
    @Modifying
    @Query("delete from Notification n where n.type = :type and n.sourceRef = :sourceRef and n.seenAt is null")
    int deleteUnseenByTypeAndSourceRef(
            @Param("type") NotificationType type, @Param("sourceRef") String sourceRef);

    /**
     * The <b>tombstone</b> half of the HYBRID admin-message <b>recall</b> (TM-473): mark every
     * already-<em>SEEN</em> notification a single campaign produced as recalled, keeping the row.
     * Complement of {@link #deleteUnseenByTypeAndSourceRef}: those rows whose recipient already viewed
     * the bell/panel that contained them ({@code seen_at is not null}) are stamped {@code recalled_at}
     * rather than deleted, so the feed API surfaces them ({@code NotificationResponse.recalled}) and the
     * panel renders them struck-through with "Recalled by admin · &lt;time&gt;" — we don't silently
     * vanish something the recipient already looked at.
     *
     * <p>Guarded by {@code recalled_at is null} so it only ever <b>sets</b> the marker on a live row and
     * never rewrites an earlier recall — the same one-way, first-moment-wins semantics as {@link
     * Notification#markRecalled(Instant)} / {@link Notification#markSeen(java.time.Instant)}. Scoped by
     * {@code type} + {@code sourceRef} like the delete half. Returns the number of rows tombstoned (the
     * tombstone-partition reach). Bulk update (not a load-mutate-save loop) so the whole seen partition
     * stamps in one statement; requires an active transaction (the recall service provides one).
     */
    @Modifying
    @Query(
            "update Notification n set n.recalledAt = :recalledAt "
                    + "where n.type = :type and n.sourceRef = :sourceRef "
                    + "and n.seenAt is not null and n.recalledAt is null")
    int markRecalledSeenByTypeAndSourceRef(
            @Param("type") NotificationType type,
            @Param("sourceRef") String sourceRef,
            @Param("recalledAt") Instant recalledAt);
}
