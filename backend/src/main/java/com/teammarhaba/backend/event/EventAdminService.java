package com.teammarhaba.backend.event;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.BadRequestException;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import jakarta.persistence.EntityManager;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Consumer;
import java.util.stream.Collectors;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Admin-side event management (TM-392): create, edit, cancel, and list — the service behind
 * {@code /api/v1/admin/events}. Authorization ({@code hasRole('ADMIN')}) is enforced at the
 * controller; this service owns the domain rules:
 *
 * <ul>
 *   <li><b>Audited</b> — every mutation appends a house audit row ({@link AuditService}, TM-113)
 *       in the same transaction, so an action and its audit trail commit or roll back together.</li>
 *   <li><b>Lifecycle seam</b> — every committed mutation also publishes an
 *       {@link EventLifecycleEvent} so lifecycle pushes (TM-397) can hook in later; nothing here
 *       knows about push.</li>
 *   <li><b>No existence leak</b> — a missing id is always a plain 404
 *       ({@link ResourceNotFoundException}), mirroring {@code UserAdminService} (TM-111).</li>
 *   <li><b>Window invariants</b> — {@code visibilityStart < visibilityEnd} and
 *       {@code endAt > startAt} are re-checked on the <em>merged</em> state after a partial edit
 *       (bean validation at the edge can only see the fields a PATCH actually carries).</li>
 *   <li><b>Cancel ≠ delete</b> — cancelling flips the status to {@code CANCELLED} and keeps the
 *       row (attendees keep their history); it is idempotent, and a repeat cancel neither
 *       re-audits nor re-notifies.</li>
 * </ul>
 */
@Service
public class EventAdminService {

    /** Audit {@code target_type} for event rows (mirrors {@code UserService.TARGET_USER}). */
    static final String TARGET_EVENT = "Event";

    private final EventRepository events;
    private final EventAttendanceRepository attendance;
    private final VenueRepository venues;
    private final UserService users;
    private final AuditService audit;
    private final ApplicationEventPublisher lifecycle;
    private final EntityManager entityManager;

    public EventAdminService(
            EventRepository events,
            EventAttendanceRepository attendance,
            VenueRepository venues,
            UserService users,
            AuditService audit,
            ApplicationEventPublisher lifecycle,
            EntityManager entityManager) {
        this.events = events;
        this.attendance = attendance;
        this.venues = venues;
        this.users = users;
        this.audit = audit;
        this.lifecycle = lifecycle;
        this.entityManager = entityManager;
    }

    /**
     * Going / waitlist tallies for one event — the counts the admin console renders per row (TM-430).
     * A record so both the single-GET and the batch listing return the same shape.
     */
    public record EventCounts(long going, long waitlist) {
        public static final EventCounts ZERO = new EventCounts(0, 0);
    }

    /**
     * The admin listing: <em>every</em> active event — cancelled ones and events whose visibility
     * window hasn't opened (or has closed) included — because the console manages the full
     * inventory, not the public view. Only soft-deleted rows are hidden (the entity's
     * {@code @SQLRestriction}).
     */
    @Transactional(readOnly = true)
    public Page<Event> list(Pageable pageable) {
        return events.findAll(pageable);
    }

    /** One event by id; 404 if absent or soft-deleted (no existence leak). */
    @Transactional(readOnly = true)
    public Event get(long id) {
        return events.findById(id).orElseThrow(EventAdminService::notFound);
    }

    /**
     * Going / waitlist counts for many events in ONE query (TM-430) — the listing's per-row badges
     * without an N+1, mirroring how {@link EventQueryService} counts the public side. States with no
     * rows simply don't appear in the tally, so an event with no attendance maps to
     * {@link EventCounts#ZERO}. An empty id set short-circuits (no query, empty map).
     */
    @Transactional(readOnly = true)
    public Map<Long, EventCounts> attendanceCounts(Collection<Long> eventIds) {
        if (eventIds.isEmpty()) {
            return Map.of();
        }
        // One grouped tally (event, state) for the whole page, then partition by state.
        List<EventAttendanceRepository.AttendanceTally> tallies = attendance.tallyByEventIds(eventIds);
        Map<Long, Long> going = tallyState(tallies, AttendanceState.GOING);
        Map<Long, Long> waitlisted = tallyState(tallies, AttendanceState.WAITLISTED);
        return eventIds.stream()
                .distinct()
                .collect(Collectors.toMap(
                        id -> id,
                        id -> new EventCounts(going.getOrDefault(id, 0L), waitlisted.getOrDefault(id, 0L))));
    }

    /** Going / waitlist counts for a single event (TM-430) — the single-GET edit-load path. */
    @Transactional(readOnly = true)
    public EventCounts attendanceCounts(long eventId) {
        return new EventCounts(
                attendance.countByEventIdAndState(eventId, AttendanceState.GOING),
                attendance.countByEventIdAndState(eventId, AttendanceState.WAITLISTED));
    }

    /** One state's per-event totals from an already-fetched grouped tally (mirrors {@code EventQueryService}). */
    private static Map<Long, Long> tallyState(
            List<EventAttendanceRepository.AttendanceTally> tallies, AttendanceState state) {
        return tallies.stream()
                .filter(t -> t.getState() == state)
                .collect(Collectors.toMap(
                        EventAttendanceRepository.AttendanceTally::getEventId,
                        EventAttendanceRepository.AttendanceTally::getTotal));
    }

    /**
     * Create a {@code PUBLISHED} event owned by the calling admin. The creator's {@code users.id}
     * is resolved through the JIT-provisioning path (TM-112), so a first-action admin always has a
     * row. Audits {@link AuditAction#EVENT_CREATED} and publishes a {@code CREATED} lifecycle
     * signal for the TM-397 seam.
     */
    @Transactional
    public Event create(VerifiedUser caller, EventDraft draft) {
        Instant now = Instant.now();
        User creator = users.provision(caller);
        Event event = new Event(
                draft.heading(),
                draft.description(),
                draft.locationText(),
                draft.timezone(),
                draft.startAt(),
                draft.visibilityStart(),
                draft.visibilityEnd(),
                creator.getId(),
                now);
        event.setMapUrl(draft.mapUrl());
        event.setOnlineUrl(draft.onlineUrl());
        event.setCity(draft.city());
        // Venue reference (TM-519): when the admin picked a saved venue, verify it exists and is
        // active (a deactivated/unknown venue is a 400) before pointing the event at it. `null` =
        // a one-off free-text location — locationText remains the display line.
        if (draft.venueId() != null) {
            requireActiveVenue(draft.venueId());
            event.setVenueId(draft.venueId());
        }
        event.setEndAt(draft.endAt());
        event.setCapacity(draft.capacity());
        event.setImagePath(draft.imagePath());
        event.setLocationRevealHours(draft.locationRevealHours());
        // Per-event booking-cutoff / cancellation-window overrides (TM-413/TM-414, wired in TM-523): a
        // null draft value leaves the column NULL = inherit the city/app default; a value (including a
        // meaningful 0) is honoured by BookingCutoffPolicy / CancellationPolicy.
        event.setBookingCutoffHours(draft.bookingCutoffHours());
        event.setCancellationWindowHours(draft.cancellationWindowHours());
        event.setAgeMin(draft.ageMin());
        event.setAgeMax(draft.ageMax());
        // Price + premium (TM-475): an omitted value leaves the entity defaults (£5 / not premium) —
        // the same values the V21 column defaults would apply — so we only override when the admin
        // actually supplied one. `price >= 0` was already enforced at the request edge.
        if (draft.pricePence() != null) {
            event.setPricePence(draft.pricePence());
        }
        if (draft.premium() != null) {
            event.setPremium(draft.premium());
        }
        requireConsistentTimes(event);
        requireConsistentAgeBand(event);

        Event saved = events.saveAndFlush(event);
        // created_at is DB-authoritative (DEFAULT now(), insertable = false): re-read it so the
        // 201 body carries the real timestamp instead of null.
        entityManager.refresh(saved);

        audit.record(
                caller.uid(),
                AuditAction.EVENT_CREATED,
                TARGET_EVENT,
                String.valueOf(saved.getId()),
                Map.of("heading", saved.getHeading()));
        lifecycle.publishEvent(
                new EventLifecycleEvent(saved.getId(), saved.getHeading(), EventLifecycleEvent.Kind.CREATED));
        return saved;
    }

    /**
     * Partial edit: apply the patch's non-{@code null} fields, then re-validate the time-window
     * invariants on the merged state. A patch that changes nothing (empty, or same values) is a
     * clean no-op — no audit row, no lifecycle signal, no {@code updatedAt} bump — so TM-397 never
     * pushes a "changed" notification for an edit that didn't. Audits
     * {@link AuditAction#EVENT_UPDATED} (with the changed field names) and publishes
     * {@code UPDATED} otherwise.
     */
    @Transactional
    public Event update(VerifiedUser caller, long id, EventPatch patch) {
        Event event = events.findById(id).orElseThrow(EventAdminService::notFound);

        List<String> changed = new ArrayList<>();
        applyIfChanged(patch.heading(), event.getHeading(), event::setHeading, "heading", changed);
        applyIfChanged(patch.description(), event.getDescription(), event::setDescription, "description", changed);
        applyIfChanged(
                patch.locationText(), event.getLocationText(), event::setLocationText, "locationText", changed);
        applyIfChanged(patch.mapUrl(), event.getMapUrl(), event::setMapUrl, "mapUrl", changed);
        applyIfChanged(patch.onlineUrl(), event.getOnlineUrl(), event::setOnlineUrl, "onlineUrl", changed);
        applyIfChanged(patch.city(), event.getCity(), event::setCity, "city", changed);
        // Venue reference (TM-519): validate ONLY a genuine re-point to a DIFFERENT venue (exists +
        // active) — so pointing an event at a deactivated/unknown venue is a 400, but re-saving an
        // event that already references a since-deactivated venue (unchanged) stays valid. Omitted =
        // unchanged.
        if (patch.venueId() != null && !patch.venueId().equals(event.getVenueId())) {
            requireActiveVenue(patch.venueId());
        }
        applyIfChanged(patch.venueId(), event.getVenueId(), event::setVenueId, "venueId", changed);
        applyIfChanged(patch.timezone(), event.getTimezone(), event::setTimezone, "timezone", changed);
        applyIfChanged(patch.startAt(), event.getStartAt(), event::setStartAt, "startAt", changed);
        applyIfChanged(patch.endAt(), event.getEndAt(), event::setEndAt, "endAt", changed);
        applyIfChanged(
                patch.visibilityStart(),
                event.getVisibilityStart(),
                event::setVisibilityStart,
                "visibilityStart",
                changed);
        applyIfChanged(
                patch.visibilityEnd(), event.getVisibilityEnd(), event::setVisibilityEnd, "visibilityEnd", changed);
        applyIfChanged(patch.capacity(), event.getCapacity(), event::setCapacity, "capacity", changed);
        applyIfChanged(patch.imagePath(), event.getImagePath(), event::setImagePath, "imagePath", changed);
        applyIfChanged(
                patch.locationRevealHours(),
                event.getLocationRevealHours(),
                event::setLocationRevealHours,
                "locationRevealHours",
                changed);
        // Per-event booking-cutoff / cancellation-window overrides (TM-523): same null-means-unchanged
        // PATCH semantics as every other field. A meaningful 0 override differs from the current value
        // and so is applied; null leaves the override untouched (it cannot be cleared back to inherit
        // through this API yet — the house PATCH trade-off, documented on EventPatch).
        applyIfChanged(
                patch.bookingCutoffHours(),
                event.getBookingCutoffHours(),
                event::setBookingCutoffHours,
                "bookingCutoffHours",
                changed);
        applyIfChanged(
                patch.cancellationWindowHours(),
                event.getCancellationWindowHours(),
                event::setCancellationWindowHours,
                "cancellationWindowHours",
                changed);
        applyIfChanged(patch.ageMin(), event.getAgeMin(), event::setAgeMin, "ageMin", changed);
        applyIfChanged(patch.ageMax(), event.getAgeMax(), event::setAgeMax, "ageMax", changed);
        // Price + premium (TM-475): boxed current values so applyIfChanged's null-means-unchanged and
        // equals-means-no-op semantics work; the primitives unbox back through the setters.
        applyIfChanged(patch.pricePence(), event.getPricePence(), event::setPricePence, "pricePence", changed);
        applyIfChanged(patch.premium(), event.isPremium(), event::setPremium, "premium", changed);

        requireConsistentTimes(event);
        requireConsistentAgeBand(event);

        if (changed.isEmpty()) {
            return event; // nothing actually changed: no touch, no audit, no lifecycle signal
        }
        event.touch(Instant.now()); // dirty-checking flushes on commit

        audit.record(
                caller.uid(),
                AuditAction.EVENT_UPDATED,
                TARGET_EVENT,
                String.valueOf(event.getId()),
                Map.of("fields", List.copyOf(changed)));
        lifecycle.publishEvent(new EventLifecycleEvent(
                event.getId(), event.getHeading(), EventLifecycleEvent.Kind.UPDATED, Set.copyOf(changed)));
        return event;
    }

    /**
     * Call the event off: status becomes {@code CANCELLED}, the row stays (readable history for
     * attendees — cancel is <em>not</em> delete). Idempotent: cancelling an already-cancelled
     * event returns it unchanged and does <em>not</em> re-audit or re-publish, so TM-397 can never
     * double-notify from a double click. Audits {@link AuditAction#EVENT_CANCELLED} and publishes
     * {@code CANCELLED} on the actual transition.
     */
    @Transactional
    public Event cancel(VerifiedUser caller, long id) {
        Event event = events.findById(id).orElseThrow(EventAdminService::notFound);
        if (!event.isPublished()) {
            return event; // already cancelled — idempotent no-op
        }
        event.cancel(Instant.now()); // dirty-checking flushes on commit

        audit.record(
                caller.uid(),
                AuditAction.EVENT_CANCELLED,
                TARGET_EVENT,
                String.valueOf(event.getId()),
                Map.of("heading", event.getHeading()));
        lifecycle.publishEvent(
                new EventLifecycleEvent(event.getId(), event.getHeading(), EventLifecycleEvent.Kind.CANCELLED));
        return event;
    }

    /** Apply {@code value} when it is present and different, recording the field name if it changed. */
    private static <T> void applyIfChanged(T value, T current, Consumer<T> setter, String field, List<String> changed) {
        if (value != null && !Objects.equals(value, current)) {
            setter.accept(value);
            changed.add(field);
        }
    }

    /**
     * The time-window invariants, checked on the <em>merged</em> entity state so a partial edit
     * can never sneak past the request-level bean validation (which only sees the fields the PATCH
     * carries): the visibility window must be ordered, and an end must come after the start.
     */
    private static void requireConsistentTimes(Event event) {
        if (!event.getVisibilityStart().isBefore(event.getVisibilityEnd())) {
            throw new BadRequestException("visibilityStart must be before visibilityEnd.");
        }
        if (event.getEndAt() != null && !event.getEndAt().isAfter(event.getStartAt())) {
            throw new BadRequestException("endAt must be after startAt.");
        }
    }

    /**
     * The age-band invariant, checked on the <em>merged</em> entity state (like
     * {@link #requireConsistentTimes}) so a partial PATCH that carries only one edge is validated
     * against the other side's persisted value: when both edges are set, the lower must not exceed
     * the upper (TM-415). The 13..120 range and non-negativity are enforced at the request edge; the
     * DB CHECK constraint is the final backstop.
     */
    private static void requireConsistentAgeBand(Event event) {
        Integer min = event.getAgeMin();
        Integer max = event.getAgeMax();
        if (min != null && max != null && min > max) {
            throw new BadRequestException("ageMin must be less than or equal to ageMax.");
        }
    }

    /**
     * The referenced venue must exist and be active (TM-519). A missing or deactivated venue is a
     * {@code 400} on the <em>event</em> request (bad input) — not a 404, since the event id itself is
     * fine; it's the picked venue that's the problem. The nullable FK + {@code ON DELETE SET NULL}
     * back this at the DB layer, but validating here gives a clean RFC-7807 message instead of a
     * constraint-violation 500.
     */
    private void requireActiveVenue(long venueId) {
        Venue venue = venues.findById(venueId).orElseThrow(() -> new BadRequestException("Unknown or inactive venue."));
        if (!venue.isActive()) {
            throw new BadRequestException("Unknown or inactive venue.");
        }
    }

    private static ResourceNotFoundException notFound() {
        return new ResourceNotFoundException("Event not found.");
    }
}
