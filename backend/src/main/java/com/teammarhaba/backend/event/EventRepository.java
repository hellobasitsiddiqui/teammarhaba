package com.teammarhaba.backend.event;

import jakarta.persistence.LockModeType;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Data access for {@link Event} (TM-391).
 *
 * <p>All queries here (and the inherited {@code findAll}/{@code findById}) honour the entity's
 * {@code @SQLRestriction}, so they return <em>active</em> rows only — soft-deleted events are
 * invisible by default.
 */
public interface EventRepository extends JpaRepository<Event, Long> {

    /**
     * The visible-now listing: events whose visibility window contains {@code now}, whose status
     * matches (the public listing passes {@link EventStatus#PUBLISHED}; cancelled events drop out
     * immediately) <em>and</em> which have not finished (TM-412). An event is finished once
     * {@code now} is past its effective end: {@code endAt} when set, else {@code startAt +
     * defaultDuration} for open-ended events — so open-ended events are kept while
     * {@code startAt ≥ openEndedStartFloor} ({@code = now − defaultDuration}, precomputed by
     * {@link EventPhasePolicy#openEndedStartFloor} to keep this a plain column comparison). Live
     * events ({@code startAt ≤ now}) naturally sort ahead of upcoming ones ({@code startAt > now})
     * under the {@code startAt}-ascending order the caller supplies, so "live to the top" falls out
     * of soonest-first. Soft-deleted events are excluded by the {@code @SQLRestriction}.
     */
    @Query(
            """
            select e from Event e
            where e.status = :status
              and e.visibilityStart <= :now
              and e.visibilityEnd >= :now
              and (
                (e.endAt is not null and e.endAt >= :now)
                or (e.endAt is null and e.startAt >= :openEndedStartFloor)
              )
            """)
    Page<Event> findVisibleAt(
            @Param("now") Instant now,
            @Param("openEndedStartFloor") Instant openEndedStartFloor,
            @Param("status") EventStatus status,
            Pageable pageable);

    /**
     * The "Past events" section of the public listing (TM-518, superseding TM-412's hide-once-finished):
     * events whose visibility window still contains {@code now} but which have already <em>finished</em>
     * — the exact complement of {@link #findVisibleAt}'s not-finished clause, so an event is in one set
     * or the other but never both nor neither. An event with an {@code endAt} is finished once
     * {@code endAt < now}; an open-ended one ({@code endAt is null}) once its start has fallen below
     * {@code openEndedStartFloor} ({@code = now − defaultDuration}), keeping this a plain column
     * comparison (mirrors {@link EventPhasePolicy#openEndedStartFloor}). Ordered most-recently-ended
     * first ({@code coalesce(endAt, startAt) desc}, id-tiebroken) so the newest past event sits at the
     * top of the section, and paged by the caller to a bounded addendum. Cancelled events (status not
     * {@code PUBLISHED}) and soft-deleted events (the {@code @SQLRestriction}) never appear.
     */
    @Query(
            """
            select e from Event e
            where e.status = :status
              and e.visibilityStart <= :now
              and e.visibilityEnd >= :now
              and (
                (e.endAt is not null and e.endAt < :now)
                or (e.endAt is null and e.startAt < :openEndedStartFloor)
              )
            order by coalesce(e.endAt, e.startAt) desc, e.id desc
            """)
    List<Event> findRecentlyFinished(
            @Param("now") Instant now,
            @Param("openEndedStartFloor") Instant openEndedStartFloor,
            @Param("status") EventStatus status,
            Pageable pageable);

    /**
     * The reminder scanner's candidate window (TM-394): events of {@code status} starting inside
     * {@code (from, to]} — strictly after {@code from} (an event starting this very instant has
     * started; nothing left to remind) and no further out than {@code to} (the scan horizon, i.e.
     * the widest milestone offset). Deliberately ignores the visibility window: reminders follow
     * <em>attendance</em>, so an event whose listing window has closed still nudges the people who
     * already joined. Soft-deleted events are excluded by the {@code @SQLRestriction}; covered by
     * {@code idx_events_start_at}.
     */
    @Query(
            """
            select e from Event e
            where e.status = :status
              and e.startAt > :from
              and e.startAt <= :to
            """)
    List<Event> findStartingBetween(
            @Param("status") EventStatus status, @Param("from") Instant from, @Param("to") Instant to);

    /**
     * Load the event holding a {@code SELECT ... FOR UPDATE} row lock — <b>the</b> locking
     * discipline for every capacity-affecting write (TM-393). RSVP, un-RSVP and claim all start by
     * taking this lock inside their transaction, so concurrent joins/claims on the same event
     * serialise: capacity checks read committed truth, oversell is impossible and first-claim-wins
     * falls out for free. Locking one {@code events} row per event keeps contention scoped — writes
     * to different events never queue behind each other. The {@code @SQLRestriction} still applies:
     * soft-deleted events don't load (or lock).
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select e from Event e where e.id = :id")
    Optional<Event> findByIdForUpdate(@Param("id") Long id);

    /**
     * The event-chat close sweep's candidate window (TM-578): events that still have an <em>open</em>
     * group thread ({@code conversation.closed_at is null}) whose effective end — {@code end_at}, or
     * {@code start_at} for an open-ended event (via {@code coalesce}) — is at or before {@code now},
     * and which can actually close under the policy. That last clause is the coarse pre-filter that
     * keeps <em>never-closing</em> events (the shipped default) out of the batch entirely, so they can
     * never fill it and starve genuinely-due threads: an event qualifies when it carries a per-event
     * {@code chat_close_hours} override, OR an app-wide default is configured
     * ({@code appDefaultConfigured}), OR its normalized city has a per-city default
     * ({@code citiesWithCloseWindow}). The authoritative per-event "is it past its close instant"
     * decision still lives in {@link EventChatClosePolicy} / {@code closeThreadIfDue} — this query only
     * bounds the set to scan.
     *
     * <p>Ordered oldest-effective-end first (id-tiebroken) so a backlog drains longest-overdue-first,
     * and paged by the caller to cap the batch. Soft-deleted events are excluded by the
     * {@code @SQLRestriction}; admin-broadcast threads never match (their {@code event_id} is null, so
     * the {@code c.eventId = e.id} join drops them).
     */
    @Query(
            """
            select e from Event e, Conversation c
            where c.eventId = e.id
              and c.closedAt is null
              and coalesce(e.endAt, e.startAt) <= :now
              and (
                e.chatCloseHours is not null
                or :appDefaultConfigured = true
                or lower(trim(e.city)) in :citiesWithCloseWindow
              )
            order by coalesce(e.endAt, e.startAt) asc, e.id asc
            """)
    List<Event> findWithOpenThreadDueForClose(
            @Param("now") Instant now,
            @Param("appDefaultConfigured") boolean appDefaultConfigured,
            @Param("citiesWithCloseWindow") Collection<String> citiesWithCloseWindow,
            Pageable pageable);

    /**
     * The caller's live GOING commitments that would block a new join under the "one active event at
     * a time" rule (TM-413): events the user holds a {@code GOING} attendance to that are still
     * {@link EventStatus#PUBLISHED} and have <em>not finished</em> — {@code now < end_at}, or
     * {@code now < start_at} for an open-ended event with no end (via {@code coalesce}). The event
     * being joined is excluded through {@code excludeEventId}, so RSVPing or claiming an event never
     * counts as its own blocker. Cancelled events (status not {@code PUBLISHED}) and soft-deleted
     * events (the {@code @SQLRestriction}) never block — both are ways an active commitment is
     * released, alongside leaving. Ordered soonest-first so the guard can name a single deterministic
     * blocker; pass a one-row {@code Pageable} — it only needs the first.
     *
     * <p>{@link EventAttendance} has no JPA association to {@link Event} (both carry plain FK ids, by
     * design), so this is an explicit id join — the same bridge the rest of the event package uses.
     */
    @Query(
            """
            select e from Event e, EventAttendance a
            where a.eventId = e.id
              and a.userId = :userId
              and a.state = com.teammarhaba.backend.event.AttendanceState.GOING
              and e.id <> :excludeEventId
              and e.status = com.teammarhaba.backend.event.EventStatus.PUBLISHED
              and (
                (e.endAt is not null and e.endAt > :now)
                or (e.endAt is null and e.startAt > :openEndedStartFloor)
              )
            order by e.startAt asc, e.id asc
            """)
    List<Event> findActiveGoingForUser(
            @Param("userId") Long userId,
            @Param("excludeEventId") Long excludeEventId,
            @Param("now") Instant now,
            @Param("openEndedStartFloor") Instant openEndedStartFloor,
            Pageable pageable);
}
