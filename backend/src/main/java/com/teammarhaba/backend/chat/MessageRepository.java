package com.teammarhaba.backend.chat;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

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
 *       <b>last-message preview</b> for the thread list.
 *   <li>{@link #countUnread(Long, Instant)} — the <b>unread count</b> relative to a member's
 *       {@code lastReadAt} cursor (a {@code null} cursor = never read = everything unread).
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

    /** Every live message in a thread — the "never read" unread total (see {@link #countUnread}). */
    long countByConversationIdAndDeletedAtIsNull(Long conversationId);

    /** Live messages created after an instant — the unread count once a member has a read cursor. */
    long countByConversationIdAndDeletedAtIsNullAndCreatedAtAfter(Long conversationId, Instant since);

    /**
     * How many live messages a member has not yet read: those in the thread created after their
     * {@code lastReadAt} cursor. Passing {@code null} for {@code since} (the member has never opened
     * the thread) counts <em>all</em> live messages — so the caller can hand the cursor straight
     * through without a null-guard. Soft-deleted messages never count.
     *
     * <p>Branches to two derived-query counts rather than one {@code (:since is null or …)} query on
     * purpose: a bound-null timestamp parameter leaves Postgres unable to infer the parameter type
     * ("could not determine data type of parameter"), so the null case gets its own type-free count.
     */
    default long countUnread(Long conversationId, Instant since) {
        return since == null
                ? countByConversationIdAndDeletedAtIsNull(conversationId)
                : countByConversationIdAndDeletedAtIsNullAndCreatedAtAfter(conversationId, since);
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
}
