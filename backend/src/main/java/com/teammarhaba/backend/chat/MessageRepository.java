package com.teammarhaba.backend.chat;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Data access for {@link Message} (TM-435) — a thread's timeline, plus the unread support.
 *
 * <p>Every read filters {@code deletedAt IS NULL} so moderation-removed messages never surface, and
 * all of them are served by the required {@code (conversation_id, created_at)} index:
 *
 * <ul>
 *   <li>{@link #findByConversationIdAndDeletedAtIsNull(Long, Pageable)} — the <b>paged timeline</b>
 *       the read API (TM-436) serves; the caller's {@link Pageable} carries the window and the sort
 *       (newest-first to page down, oldest-first to render up), so one finder covers both directions.
 *   <li>{@link #findFirstByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(Long)} — the
 *       <b>last-message preview</b> for a <em>single</em> thread (the mark-read cursor anchor).
 *   <li>{@link #countUnread(Long, Instant)} — the <b>unread count</b> relative to a member's
 *       {@code lastReadAt} cursor (a {@code null} cursor = never read = everything unread), for a
 *       <em>single</em> thread.
 * </ul>
 *
 * <p><b>Batched list-path finders (TM-581).</b> The conversation <em>list</em> ({@link
 * ConversationReadService#list}) must not fan the two single-thread finders above out per membership
 * (an N+1: {@code 1 + 1 + 1 + 2N} queries that did full work even for page 2+). Instead it resolves
 * both in one shot, keyed by conversation id, so the query count is constant regardless of how many
 * threads the caller is in:
 *
 * <ul>
 *   <li>{@link #findLatestLiveMessagePerConversation(Collection)} — the newest live message of each
 *       of a set of threads (one row per thread), for the list's last-message preview + sort key.
 *   <li>{@link #unreadCountsForUser(Long)} — every thread's per-member unread count for one user in a
 *       single grouped count (threads with nothing unread are simply absent → treated as {@code 0}).
 * </ul>
 */
public interface MessageRepository extends JpaRepository<Message, Long> {

    /**
     * A page of a thread's live messages. The {@link Pageable} carries both the window and the sort
     * — pass {@code Sort.by("createdAt").descending().and(Sort.by("id").descending())} to page
     * newest-first, or ascending to render oldest→newest. {@code id} is the deterministic
     * same-instant tiebreak.
     */
    Page<Message> findByConversationIdAndDeletedAtIsNull(Long conversationId, Pageable pageable);

    /** A thread's live messages newest-first as a list ({@code id} breaks same-{@code createdAt} ties). */
    List<Message> findByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(Long conversationId);

    /** The most recent live message in a thread — the thread-list preview; empty for a silent thread. */
    Optional<Message> findFirstByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(
            Long conversationId);

    /**
     * Every live message in a thread another member could still have unread for {@code userId} — the
     * "never read" unread total (see {@link #countUnread}). The member's <em>own</em> messages are
     * excluded (TM-680): posting doesn't advance the read cursor, so without this predicate a sender's
     * just-sent message counted as "unread by them" and badged them for their own words. A system
     * message carries a {@code null} {@code senderId} and still counts for everyone.
     */
    @Query(
            """
            SELECT COUNT(m) FROM Message m
            WHERE m.conversationId = :conversationId
              AND m.deletedAt IS NULL
              AND (m.senderId IS NULL OR m.senderId <> :userId)
            """)
    long countUnreadNeverRead(@Param("conversationId") Long conversationId, @Param("userId") Long userId);

    /**
     * Live messages created after an instant, excluding {@code userId}'s own (TM-680, same rule as
     * {@link #countUnreadNeverRead}) — the unread count once a member has a read cursor.
     */
    @Query(
            """
            SELECT COUNT(m) FROM Message m
            WHERE m.conversationId = :conversationId
              AND m.deletedAt IS NULL
              AND m.createdAt > :since
              AND (m.senderId IS NULL OR m.senderId <> :userId)
            """)
    long countUnreadAfter(
            @Param("conversationId") Long conversationId,
            @Param("userId") Long userId,
            @Param("since") Instant since);

    /**
     * How many live messages a member has not yet read: those in the thread created after their
     * {@code lastReadAt} cursor, <em>excluding their own</em> (TM-680 — your own message is never
     * unread by you; a {@code null}-sender system message counts for everyone). Passing {@code null}
     * for {@code since} (the member has never opened the thread) counts <em>all</em> such messages —
     * so the caller can hand the cursor straight through without a null-guard. Soft-deleted messages
     * never count.
     *
     * <p>Branches to two counts rather than one {@code (:since is null or …)} query on purpose: a
     * bound-null timestamp parameter leaves Postgres unable to infer the parameter type ("could not
     * determine data type of parameter"), so the null case gets its own type-free count.
     */
    default long countUnread(Long conversationId, Long userId, Instant since) {
        return since == null
                ? countUnreadNeverRead(conversationId, userId)
                : countUnreadAfter(conversationId, userId, since);
    }

    /**
     * The database's own current instant ({@code now()}). Read-cursor stamping (TM-580) must use a
     * DB-sourced instant, not the app clock: {@code message.created_at} is DB-authoritative
     * ({@code DEFAULT now()}) and {@link #countUnread} compares {@code created_at > last_read_at}, so
     * under app/DB clock skew an app-clock cursor can leave a just-seen message counted unread (or,
     * in the reverse skew, mark a later message read). The mark-read path prefers the newest live
     * message's {@code created_at}; this is the fallback for a <em>silent</em> thread (no live message
     * to anchor to), keeping the cursor on the same clock as any message that later arrives.
     *
     * <p>Native {@code SELECT now()} — {@code now()} returns the transaction's start instant, which is
     * exactly the clock the DB stamps {@code created_at} with in a subsequently-started insert.
     */
    @Query(value = "SELECT now()", nativeQuery = true)
    Instant databaseNow();

    /**
     * The newest live message of each of the given threads — one row per conversation id (the thread
     * that has no live message simply doesn't appear), batched for the conversation list (TM-581) so
     * its last-message preview + sort key cost one query instead of one finder per membership.
     *
     * <p>Uses Postgres {@code DISTINCT ON (conversation_id)} with the SAME order the single-thread
     * finder uses ({@code created_at DESC, id DESC}) so the "latest" it keeps is identical row-for-row
     * to {@link #findFirstByConversationIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc} — {@code id}
     * breaks a same-{@code created_at} tie deterministically. Soft-deleted messages are excluded
     * ({@code deleted_at IS NULL}), matching every other read. Native (not derived/JPQL) because
     * {@code DISTINCT ON} is a Postgres extension with no JPQL equivalent; {@code m.*} maps straight
     * back onto the {@link Message} entity. The caller must not pass an empty collection (an empty SQL
     * {@code IN ()} is invalid) — it guards that and returns an empty map instead.
     */
    @Query(
            value =
                    """
                    SELECT DISTINCT ON (m.conversation_id) m.*
                    FROM message m
                    WHERE m.conversation_id IN (:conversationIds)
                      AND m.deleted_at IS NULL
                    ORDER BY m.conversation_id, m.created_at DESC, m.id DESC
                    """,
            nativeQuery = true)
    List<Message> findLatestLiveMessagePerConversation(
            @Param("conversationIds") Collection<Long> conversationIds);

    /**
     * Every thread's unread count for one user, in a single grouped count keyed by conversation id
     * (TM-581) — the batched replacement for calling {@link #countUnread} once per membership.
     *
     * <p>Joins each of the user's memberships to its thread's live messages and counts those created
     * after that membership's {@code lastReadAt} cursor (a {@code null} cursor = never opened =
     * everything unread — same rule as {@link #countUnread}), excluding the member's <em>own</em>
     * messages (TM-680 — posting doesn't move the cursor, so without this a sender was badged for
     * their own just-sent message; {@code null}-sender system messages still count for everyone).
     * One membership per (thread, user) — the
     * {@code UNIQUE (conversation_id, user_id)} constraint — so a thread yields at most one row. A
     * thread with <em>nothing</em> unread (cursor past every message, or silent) produces no group row
     * at all, so the caller reads it back as {@code 0} via {@code getOrDefault}. Scoped by user, so the
     * result spans exactly the caller's threads (removed memberships included, but those are dropped
     * from the list upstream and simply never looked up). Soft-deleted messages never count.
     */
    @Query(
            """
            SELECT m.conversationId AS conversationId, COUNT(m) AS unread
            FROM Message m, ConversationMember cm
            WHERE cm.conversationId = m.conversationId
              AND cm.userId = :userId
              AND m.deletedAt IS NULL
              AND (m.senderId IS NULL OR m.senderId <> cm.userId)
              AND (cm.lastReadAt IS NULL OR m.createdAt > cm.lastReadAt)
            GROUP BY m.conversationId
            """)
    List<ConversationUnreadCount> unreadCountsForUser(@Param("userId") Long userId);

    /**
     * One thread's unread count for the caller — a projection row of {@link #unreadCountsForUser}. Only
     * threads with a non-zero unread count appear; an absent thread is {@code 0} unread.
     */
    interface ConversationUnreadCount {

        /** The thread this count belongs to. */
        Long getConversationId();

        /** How many live messages the caller has not yet read in that thread (always {@code >= 1} here). */
        long getUnread();
    }
}
