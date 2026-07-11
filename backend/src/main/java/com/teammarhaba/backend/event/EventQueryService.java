package com.teammarhaba.backend.event;

import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The public read side of events (TM-393): the visible-now listing and the detail view.
 *
 * <p><b>Visibility</b> — an event is publicly readable while {@code PUBLISHED} and inside its
 * visibility window; cancelled, out-of-window and soft-deleted events are hidden — the detail
 * endpoint 404s them indistinguishably from a missing id.
 *
 * <p><b>Caller state without provisioning</b> — reads resolve the caller by Firebase UID but never
 * provision an account (reads should not write); an unprovisioned caller simply has
 * {@link MyState#NONE} everywhere. The write side ({@link EventRsvpService}) provisions
 * just-in-time as usual.
 *
 * <p><b>People</b> — the attendee-avatar strip resolves through the {@code User} aggregate, whose
 * {@code @SQLRestriction} hides soft-deleted accounts: a tombstoned attendee drops out of the strip
 * (their attendance row still holds the spot, so counts stay truthful about capacity).
 */
@Service
public class EventQueryService {

    /** How many attendee avatars the detail view carries — the first N {@code GOING}, join order. */
    public static final int ATTENDEE_AVATAR_LIMIT = 5;

    /**
     * How many recently-finished events the listing's "Past events" section carries (TM-518). A bounded
     * addendum appended after the active page — enough to show a meaningful history without unbounded
     * growth as events accumulate; older past events age out of their visibility window anyway.
     */
    static final int PAST_LISTING_LIMIT = 50;

    /** Avatar strip order: join order (DB-authoritative {@code createdAt}, id as same-instant tiebreak). */
    private static final Sort JOIN_ORDER = Sort.by(Sort.Order.asc("createdAt"), Sort.Order.asc("id"));

    private final EventRepository events;
    private final EventAttendanceRepository attendance;
    private final UserRepository users;
    private final LocationRevealPolicy reveal;
    private final EventPhasePolicy phase;
    private final AgeEligibilityPolicy ageGate;
    private final BookingCutoffPolicy bookingCutoff;

    public EventQueryService(
            EventRepository events,
            EventAttendanceRepository attendance,
            UserRepository users,
            LocationRevealPolicy reveal,
            EventPhasePolicy phase,
            AgeEligibilityPolicy ageGate,
            BookingCutoffPolicy bookingCutoff) {
        this.events = events;
        this.attendance = attendance;
        this.users = users;
        this.reveal = reveal;
        this.phase = phase;
        this.ageGate = ageGate;
        this.bookingCutoff = bookingCutoff;
    }

    /**
     * The visible-now listing plus its "Past events" section (TM-518, superseding TM-412's
     * hide-once-finished). The paged part is the ACTIVE listing exactly as before — {@code PUBLISHED}
     * events whose visibility window contains now and which have <em>not</em> finished, in the
     * caller-supplied page order (the API fixes soonest-first, which sorts live events ahead of upcoming
     * ones). On the <b>first page</b> a bounded set of recently-finished events (still inside their
     * visibility window, most-recently-ended first) is <em>appended</em> after the active rows — the
     * client groups them into a de-emphasised, read-only "Past events" section by their
     * {@link EventPhase#FINISHED} tag. Past events are a fixed-size addendum, not part of the paging, so
     * they ride only page 0 and never inflate {@code totalElements}; the client browse list reads
     * {@code items} directly. Going counts and the caller's states are tallied once over the union of
     * active + past ids — no N+1 regardless of page size.
     */
    @Transactional(readOnly = true)
    public PageResponse<EventCard> visibleNow(String callerUid, Pageable pageable) {
        Instant now = Instant.now();
        Instant floor = phase.openEndedStartFloor(now);
        Page<Event> active = events.findVisibleAt(now, floor, EventStatus.PUBLISHED, pageable);
        // The "Past events" section (TM-518): a bounded, most-recently-ended-first addendum, only on the
        // first page (it is not paged content). Empty on later pages so it never repeats down the list.
        List<Event> past = pageable.getPageNumber() == 0
                ? events.findRecentlyFinished(
                        now, floor, EventStatus.PUBLISHED, PageRequest.of(0, PAST_LISTING_LIMIT))
                : List.of();

        // Active rows first, then the past section — the order the client renders top-to-bottom.
        List<Event> all = new ArrayList<>(active.getContent());
        all.addAll(past);
        List<Long> eventIds = all.stream().map(Event::getId).toList();

        Map<Long, Long> goingCounts = eventIds.isEmpty()
                ? Map.of()
                : attendance.tallyByEventIds(eventIds).stream()
                        .filter(t -> t.getState() == AttendanceState.GOING)
                        .collect(Collectors.toMap(
                                EventAttendanceRepository.AttendanceTally::getEventId,
                                EventAttendanceRepository.AttendanceTally::getTotal));
        Map<Long, AttendanceState> myStates = callerId(callerUid)
                .filter(id -> !eventIds.isEmpty())
                .map(id -> attendance.findByUserIdAndEventIdIn(id, eventIds).stream()
                        .collect(Collectors.toMap(EventAttendance::getEventId, EventAttendance::getState)))
                .orElse(Map.of());

        List<EventCard> cards =
                all.stream().map(event -> toCard(event, now, goingCounts, myStates)).toList();
        // Paging metadata stays that of the ACTIVE query — the past section is an addendum, not paged —
        // so `totalElements`/`totalPages` describe the active listing the caller is walking.
        return new PageResponse<>(
                cards, active.getNumber(), active.getSize(), active.getTotalElements(), active.getTotalPages());
    }

    /** Project one event to its listing card at {@code now}, reading counts + my-state from the batches. */
    private EventCard toCard(
            Event event, Instant now, Map<Long, Long> goingCounts, Map<Long, AttendanceState> myStates) {
        // Location-reveal guard (TM-408): withhold the exact venue until the reveal boundary;
        // the coarse city hint + reveal timestamp are always safe to expose.
        boolean revealed = reveal.isRevealed(event, now);
        EventPhase phaseNow = phase.phaseAt(event, now);
        return new EventCard(
                event.getId(),
                event.getHeading(),
                revealed ? event.getLocationText() : null,
                event.getCity(),
                event.getTimezone(),
                event.getStartAt(),
                event.getEndAt(),
                event.getCapacity(),
                event.getImagePath(),
                event.getPricePence(),
                event.isPremium(),
                goingCounts.getOrDefault(event.getId(), 0L),
                MyState.of(myStates.get(event.getId())),
                revealed,
                reveal.revealsAt(event),
                phaseNow,
                phaseNow == EventPhase.HAPPENING_NOW);
    }

    /**
     * The detail view: full card fields, both counts, the first {@value #ATTENDEE_AVATAR_LIMIT}
     * attendee avatars in join order, and the caller's own state. {@code spotAvailableToClaim} is
     * {@code true} only when the caller is waitlisted with a <em>live offer</em>
     * ({@code offer_notified_at} stamped by TM-397's cascade, not yet voided), a free spot still
     * exists, <b>and</b> booking has not closed ({@link BookingCutoffPolicy#isPastCutoff} is false,
     * TM-424) — the affordance behind the "claim your spot" call-to-action, kept in lock-step with
     * what {@link EventRsvpService#claim} will actually accept.
     */
    @Transactional(readOnly = true)
    public EventDetail detail(String callerUid, Long eventId) {
        Instant now = Instant.now();
        // A finished event stays READABLE (TM-518, superseding TM-412's 404-once-finished): its detail
        // is served read-only so a "Past events" card can open, carrying an {@link EventPhase#FINISHED}
        // tag; the booking-cutoff gate already closes RSVP/claim so nothing here is actionable. Only
        // cancelled / out-of-window / soft-deleted events still 404 (via {@code isVisibleAt}),
        // indistinguishably from a missing id.
        Event event = events.findById(eventId)
                .filter(e -> e.isVisibleAt(now))
                .orElseThrow(() -> new ResourceNotFoundException(EventRsvpService.EVENT_NOT_FOUND));

        long going = attendance.countByEventIdAndState(eventId, AttendanceState.GOING);
        long waitlisted = attendance.countByEventIdAndState(eventId, AttendanceState.WAITLISTED);
        // Resolve the caller once (reads never provision): their id drives my-state, their age the
        // age-eligibility verdict (TM-415). An unprovisioned caller is simply absent from both.
        Optional<User> caller = users.findByFirebaseUid(callerUid);
        Optional<EventAttendance> mine =
                caller.map(User::getId).flatMap(id -> attendance.findByEventIdAndUserId(eventId, id));

        // A live offer is claimable only while a spot is free AND booking is still open (TM-424): once
        // past the cutoff, claim 409s BOOKING_CLOSED, so the "claim your spot" affordance must go dark
        // to match — mirroring the same gate the offer cascade now applies before it ever offers.
        boolean spotFree = !event.hasCapacityLimit() || going < event.getCapacity();
        boolean spotAvailableToClaim = spotFree
                && !bookingCutoff.isPastCutoff(event, now)
                && mine.map(EventAttendance::hasOpenOffer).orElse(false);

        // Location-reveal guard (TM-408): the exact venue/map/online link are withheld until the
        // reveal boundary, uniformly for every caller (GOING/WAITLISTED included). Pre-reveal the
        // client has only the coarse city hint + the reveal timestamp.
        boolean revealed = reveal.isRevealed(event, now);
        EventPhase phaseNow = phase.phaseAt(event, now);

        return new EventDetail(
                event.getId(),
                event.getHeading(),
                event.getDescription(),
                revealed ? event.getLocationText() : null,
                revealed ? event.getMapUrl() : null,
                revealed ? event.getOnlineUrl() : null,
                event.getCity(),
                event.getTimezone(),
                event.getStartAt(),
                event.getEndAt(),
                event.getCapacity(),
                event.getImagePath(),
                event.getPricePence(),
                event.isPremium(),
                going,
                waitlisted,
                avatars(eventId),
                MyState.of(mine.map(EventAttendance::getState).orElse(null)),
                spotAvailableToClaim,
                revealed,
                reveal.revealsAt(event),
                phaseNow,
                phaseNow == EventPhase.HAPPENING_NOW,
                event.getAgeMin(),
                event.getAgeMax(),
                ageGate.eligibility(event, caller.map(User::getAge).orElse(null)),
                bookingCutoff.cutoffAt(event));
    }

    /**
     * The avatar strip: the first {@value #ATTENDEE_AVATAR_LIMIT} {@code GOING} attendance rows in
     * join order, resolved through {@code User} in one batched read and re-sequenced to the join
     * order (a {@code findAllById} result is unordered). Soft-deleted accounts resolve to nothing
     * and drop out, so the strip may carry fewer faces than {@code goingCount} — honest, not a bug.
     */
    private List<AttendeeAvatar> avatars(Long eventId) {
        List<EventAttendance> firstGoing = attendance.findByEventIdAndState(
                eventId, AttendanceState.GOING, PageRequest.of(0, ATTENDEE_AVATAR_LIMIT, JOIN_ORDER));
        List<Long> userIds = firstGoing.stream().map(EventAttendance::getUserId).toList();
        Map<Long, User> byId =
                users.findAllById(userIds).stream().collect(Collectors.toMap(User::getId, Function.identity()));
        return userIds.stream()
                .map(byId::get)
                .filter(user -> user != null)
                .map(AttendeeAvatar::from)
                .toList();
    }

    /** Resolve the caller's {@code users.id} if their account exists — reads never provision. */
    private Optional<Long> callerId(String callerUid) {
        return users.findByFirebaseUid(callerUid).map(User::getId);
    }
}
