package com.teammarhaba.backend.membership;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventPhasePolicy;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Instant;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Resolves the caller's entitlement to a specific event (TM-476) — the runtime glue behind
 * {@code GET /api/v1/events/{id}/entitlement}. It loads the event (applying the public visibility rule)
 * and the caller's membership, then hands the four decision inputs to the pure
 * {@link EntitlementResolver}. Keeping the I/O here and the rule in the pure resolver means the whole
 * tier × event matrix is exhaustively unit-testable without a database.
 *
 * <p><strong>Visibility / 404.</strong> The event is loaded under the <em>same</em> rule the public
 * detail endpoint uses (TM-393/TM-412): {@code PUBLISHED}, inside its visibility window and not yet
 * finished. A hidden / cancelled / out-of-window / finished / soft-deleted / missing event is an
 * indistinguishable {@code 404} — you can only price an event you could actually see and RSVP to.
 *
 * <p><strong>Membership.</strong> The caller's membership is read through
 * {@link MembershipService#getOrEnrol}, which just-in-time enrols a brand-new account onto
 * {@code PAY_PER_EVENT} exactly as {@code GET /me/membership} does (TM-474) — so pricing an event as a
 * first-time caller both enrols them and returns a well-defined entitlement. Identity always comes from
 * the verified token, never the request. The event is loaded first, so a hidden event 404s without
 * enrolling anything.
 */
@Service
public class EntitlementService {

    /** RFC 7807 {@code detail} for a hidden/missing event — matches the public events surface copy. */
    private static final String EVENT_NOT_FOUND = "Event not found.";

    private final EventRepository events;
    private final EventPhasePolicy phase;
    private final MembershipService memberships;

    public EntitlementService(EventRepository events, EventPhasePolicy phase, MembershipService memberships) {
        this.events = events;
        this.phase = phase;
        this.memberships = memberships;
    }

    /**
     * Resolve what {@code caller} would pay to attend event {@code eventId} (TM-476). 404s a
     * hidden/missing event (the same rule the detail view applies), otherwise reads the caller's
     * membership (JIT-enrolling if new) and returns the pure {@link EntitlementResolver} verdict.
     *
     * <p>Runs in one writable transaction: the event read and the possible membership enrolment share it,
     * and the entity reads it needs ({@code tier}, {@code firstEventCreditUsed}, {@code premium},
     * {@code pricePence}) are all taken inside it.
     *
     * @param caller  the verified caller (identity source; never the request body)
     * @param eventId the event to price
     * @return the caller's entitlement to that event
     * @throws ResourceNotFoundException if the event is not visible to the caller (a uniform {@code 404})
     */
    @Transactional
    public Entitlement resolve(VerifiedUser caller, Long eventId) {
        Instant now = Instant.now();
        // Same visibility gate as EventQueryService.detail: a hidden/cancelled/finished event 404s
        // indistinguishably from a missing id (and soft-deleted rows never load, per @SQLRestriction).
        Event event = events.findById(eventId)
                .filter(e -> e.isVisibleAt(now) && !phase.isFinished(e, now))
                .orElseThrow(() -> new ResourceNotFoundException(EVENT_NOT_FOUND));

        Membership membership = memberships.getOrEnrol(caller);
        // The credit counts as available for the ONE event that consumed it (TM-629): the caller's
        // entitlement to that event IS their free first event, before and after the commitment spends
        // the credit. Without this, a free-first commitment (checkout, or the direct RSVP verb — which
        // now also consumes on commitment) flipped the same event's entitlement to PAY the moment it
        // was consumed — so a free-first WAITLISTED member could never pass the paid-join gate to claim
        // a freed spot, and the entitlement display demanded payment for the event they already hold.
        boolean creditAvailableHere = !membership.isFirstEventCreditUsed()
                || eventId.equals(membership.getFirstEventCreditEventId());
        return EntitlementResolver.resolve(
                membership.getTier(), creditAvailableHere, event.isPremium(), event.getPricePence());
    }
}
