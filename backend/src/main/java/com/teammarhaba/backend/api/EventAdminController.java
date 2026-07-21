package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.event.BookingCutoffPolicy;
import com.teammarhaba.backend.event.CancellationPolicy;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventAdminService;
import com.teammarhaba.backend.event.EventAdminService.EventCounts;
import com.teammarhaba.backend.event.EventPhasePolicy;
import com.teammarhaba.backend.event.EventRosterAdminService;
import com.teammarhaba.backend.event.LocationRevealPolicy;
import jakarta.validation.Valid;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Admin event-management API under {@code /api/v1/admin/events} (TM-392, events epic) — the
 * backend for the admin events console. The whole controller is gated by
 * {@code @PreAuthorize("hasRole('ADMIN')")}: a non-admin gets a uniform {@code 403}, an anonymous
 * caller a {@code 401} from the security chain, and a missing id is always a plain {@code 404}
 * (no existence leak) — the TM-111 pattern.
 *
 * <ul>
 *   <li>{@code GET /admin/events} — paged listing of the <b>full inventory</b>: cancelled events
 *       and events whose visibility window hasn't opened yet included (the console manages
 *       everything; only soft-deleted rows are hidden).</li>
 *   <li>{@code GET /admin/events/{id}} — one event (edit-form load).</li>
 *   <li>{@code POST /admin/events} — create; {@code 201} with the persisted event.</li>
 *   <li>{@code PATCH /admin/events/{id}} — partial edit ({@code null} = leave unchanged).</li>
 *   <li>{@code POST /admin/events/{id}/cancel} — call it off; the record is kept with status
 *       {@code CANCELLED}. Idempotent.</li>
 * </ul>
 *
 * <p>Every mutation is audited (TM-113) and emits an {@code EventLifecycleEvent} — the seam
 * lifecycle pushes (TM-397) will consume; no push logic lives here. Event images ride the house
 * avatar pattern (TM-166): the console uploads {@code event-images/{eventId}} straight to Firebase
 * Storage (admin-only per {@code storage.rules}) and persists only the path via PATCH. Errors are
 * RFC-7807 ({@code GlobalExceptionHandler}); lists use the shared TM-115 conventions
 * ({@link PageRequests}/{@link PageResponse}). Lives in the {@code api} package so it inherits the
 * package-driven {@code /api/v1} prefix ({@link ApiV1Config}).
 */
@RestController
@RequestMapping("/admin/events")
@PreAuthorize("hasRole('ADMIN')")
public class EventAdminController {

    /** Sortable columns, allow-listed per TM-115 so internals (e.g. {@code deletedAt}) never leak. */
    static final Set<String> SORTABLE =
            Set.of("id", "heading", "startAt", "visibilityStart", "visibilityEnd", "status", "createdAt", "updatedAt");

    /** Default order: latest-scheduled first — newly planned events surface at the top of the console. */
    private static final Sort DEFAULT_SORT = Sort.by(Sort.Direction.DESC, "startAt");

    private final EventAdminService adminService;
    private final EventRosterAdminService rosterService;
    private final LocationRevealPolicy reveal;
    private final BookingCutoffPolicy cutoff;
    private final CancellationPolicy cancellation;
    private final EventPhasePolicy phase;

    public EventAdminController(
            EventAdminService adminService,
            EventRosterAdminService rosterService,
            LocationRevealPolicy reveal,
            BookingCutoffPolicy cutoff,
            CancellationPolicy cancellation,
            EventPhasePolicy phase) {
        this.adminService = adminService;
        this.rosterService = rosterService;
        this.reveal = reveal;
        this.cutoff = cutoff;
        this.cancellation = cancellation;
        this.phase = phase;
    }

    @GetMapping
    public PageResponse<EventResponse> list(
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size,
            @RequestParam(required = false) String sort) {
        Page<Event> events = adminService.list(PageRequests.of(page, size, sort, SORTABLE, DEFAULT_SORT));
        // Per-row going/waitlist counts for the whole page in ONE query (TM-430) — no N+1. A countless
        // event maps to EventCounts.ZERO. The counting lives in the service (JPA access), like the
        // public side's EventQueryService; the controller only maps entity -> DTO.
        List<Long> ids = events.getContent().stream().map(Event::getId).toList();
        Map<Long, EventCounts> counts = adminService.attendanceCounts(ids);
        // "now" is fixed once for the whole page so every row's `past` flag (TM-518) is decided against
        // the same instant.
        Instant now = Instant.now();
        return PageResponse.from(events, event -> {
            EventCounts c = counts.getOrDefault(event.getId(), EventCounts.ZERO);
            return EventResponse.from(
                    event, reveal, cutoff, cancellation, phase.isFinished(event, now), c.going(), c.waitlist());
        });
    }

    @GetMapping("/{id}")
    public EventResponse get(@PathVariable long id) {
        Event event = adminService.get(id);
        EventCounts counts = adminService.attendanceCounts(id);
        return EventResponse.from(
                event, reveal, cutoff, cancellation, phase.isFinished(event, Instant.now()), counts.going(), counts.waitlist());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public EventResponse create(
            @RequestBody @Valid CreateEventRequest request, @AuthenticationPrincipal VerifiedUser caller) {
        Event created = adminService.create(caller, request.toDraft());
        return EventResponse.from(created, reveal, cutoff, cancellation, phase.isFinished(created, Instant.now()));
    }

    @PatchMapping("/{id}")
    public EventResponse update(
            @PathVariable long id,
            @RequestBody @Valid UpdateEventRequest request,
            @AuthenticationPrincipal VerifiedUser caller) {
        Event updated = adminService.update(caller, id, request.toPatch());
        return EventResponse.from(updated, reveal, cutoff, cancellation, phase.isFinished(updated, Instant.now()));
    }

    /**
     * Cancel — deliberately a POST sub-action rather than a DELETE: the event is called off but
     * the record (and its attendance history) survives, visible in this console with status
     * {@code CANCELLED}.
     */
    @PostMapping("/{id}/cancel")
    public EventResponse cancel(@PathVariable long id, @AuthenticationPrincipal VerifiedUser caller) {
        Event cancelled = adminService.cancel(caller, id);
        return EventResponse.from(cancelled, reveal, cutoff, cancellation, phase.isFinished(cancelled, Instant.now()));
    }

    // --------------------------------------------------------------- roster + capacity (TM-592)

    /**
     * The admin roster for one event — GOING (join order) then WAITLISTED (FIFO), each with its over-cap
     * flag, plus the capacity and counts. Backs the console's roster view + its evict/add controls.
     */
    @GetMapping("/{id}/roster")
    public RosterViewResponse roster(@PathVariable long id) {
        return RosterViewResponse.from(rosterService.roster(id));
    }

    /**
     * Adjust capacity as a first-class increase/decrease (TM-592). An increase frees spots the waitlist
     * offer cascade then offers; a decrease below the current GOING count is allowed (the event sits
     * over-cap — no attendee is auto-evicted) and the response carries the over-capacity warning.
     * Capacity-locked in the service (same {@code SELECT … FOR UPDATE} lock as the RSVP verbs).
     */
    @PostMapping("/{id}/capacity")
    public CapacityAdjustResponse adjustCapacity(
            @PathVariable long id,
            @RequestBody @Valid AdjustCapacityRequest request,
            @AuthenticationPrincipal VerifiedUser caller) {
        return CapacityAdjustResponse.from(rosterService.adjustCapacity(caller, id, request.capacity()));
    }

    /**
     * Force-add a specific existing user as GOING (TM-592). Respects capacity + age/eligibility + the
     * one-active-GOING guard by default; an explicit audited {@code override} bypasses them. Capacity-locked.
     */
    @PostMapping("/{id}/attendees")
    public RosterActionResponse forceAddAttendee(
            @PathVariable long id,
            @RequestBody @Valid ForceAddAttendeeRequest request,
            @AuthenticationPrincipal VerifiedUser caller) {
        return RosterActionResponse.from(
                rosterService.forceAddAttendee(caller, id, request.userId(), request.override()));
    }

    /**
     * Evict a specific attendee (TM-592): removes their GOING/WAITLISTED row (a freed GOING spot is
     * cascade eligible), drops them from the event chat, notifies them and audits it. The evicted user is
     * not banned and may re-RSVP. Idempotent. Capacity-locked.
     */
    @PostMapping("/{id}/attendees/{userId}/evict")
    public RosterActionResponse evictAttendee(
            @PathVariable long id, @PathVariable long userId, @AuthenticationPrincipal VerifiedUser caller) {
        return RosterActionResponse.from(rosterService.evictAttendee(caller, id, userId));
    }
}
