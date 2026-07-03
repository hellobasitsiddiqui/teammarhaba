package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.event.EventCard;
import com.teammarhaba.backend.event.EventDetail;
import com.teammarhaba.backend.event.EventQueryService;
import com.teammarhaba.backend.event.EventRsvpService;
import com.teammarhaba.backend.event.RsvpResult;
import java.util.Set;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * The public events surface under {@code /api/v1/events} (TM-393; the prefix is applied by
 * {@link ApiV1Config}). Every route requires a signed-in caller — an anonymous request gets the
 * uniform RFC 7807 {@code 401} from the security chain (default-deny).
 *
 * <ul>
 *   <li>{@code GET /events} — visible-now listing (PUBLISHED, inside the visibility window),
 *       soonest-first, paged via the shared list convention; cards carry the going count and the
 *       caller's own state.</li>
 *   <li>{@code GET /events/{id}} — detail: counts, the first N attendee avatars (resolved through
 *       {@code User}), the caller's state incl. {@code WAITLISTED}, and
 *       {@code spotAvailableToClaim} when an open spot and a live offer exist for the caller.</li>
 *   <li>{@code POST /events/{id}/rsvp} — transactional, capacity-safe RSVP; lands
 *       {@code WAITLISTED} (FIFO) when the event is full or a waitlist exists. Idempotent.</li>
 *   <li>{@code DELETE /events/{id}/rsvp} — leave the event; a freed {@code GOING} spot is recorded
 *       for the offer cascade (derived free-spot count — <b>no auto-promotion</b>). Idempotent.</li>
 *   <li>{@code POST /events/{id}/claim} — a waitlisted member claims an open spot:
 *       first-claim-wins under the same event lock as RSVP; losing the race is a {@code 409} with
 *       honest copy.</li>
 * </ul>
 *
 * <p>Hidden events (cancelled / outside the window / soft-deleted) are a {@code 404} on every
 * route; attendance changes after {@code startAt} are a {@code 409}.
 */
@RestController
public class EventController {

    /** The listing order the AC fixes: soonest-first (id as a deterministic same-instant tiebreak). */
    private static final Sort SOONEST_FIRST = Sort.by(Sort.Order.asc("startAt"), Sort.Order.asc("id"));

    private final EventQueryService queries;
    private final EventRsvpService rsvps;

    EventController(EventQueryService queries, EventRsvpService rsvps) {
        this.queries = queries;
        this.rsvps = rsvps;
    }

    /** The visible-now listing, soonest-first. Order is fixed — only page/size are caller-tunable. */
    @GetMapping("/events")
    PageResponse<EventCard> list(
            @AuthenticationPrincipal VerifiedUser caller,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size) {
        return queries.visibleNow(caller.uid(), PageRequests.of(page, size, null, Set.of(), SOONEST_FIRST));
    }

    @GetMapping("/events/{id}")
    EventDetail detail(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return queries.detail(caller.uid(), id);
    }

    /** RSVP (or re-RSVP, idempotently). Returns where the caller landed plus fresh counts. */
    @PostMapping("/events/{id}/rsvp")
    RsvpResult rsvp(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return rsvps.rsvp(caller, id);
    }

    /** Leave the event (idempotent). {@code 204} — there is no body to return. */
    @DeleteMapping("/events/{id}/rsvp")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void cancelRsvp(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        rsvps.cancelRsvp(caller, id);
    }

    /** Claim an open spot from the waitlist — first-claim-wins, capacity-safe. */
    @PostMapping("/events/{id}/claim")
    RsvpResult claim(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return rsvps.claim(caller, id);
    }
}
