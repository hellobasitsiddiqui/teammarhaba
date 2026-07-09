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
}
