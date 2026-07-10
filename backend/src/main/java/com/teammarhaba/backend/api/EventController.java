package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.event.CancelResult;
import com.teammarhaba.backend.event.EventCard;
import com.teammarhaba.backend.event.EventDetail;
import com.teammarhaba.backend.event.EventQueryService;
import com.teammarhaba.backend.event.EventRsvpService;
import com.teammarhaba.backend.event.RsvpResult;
import com.teammarhaba.backend.membership.CheckoutCancelResult;
import com.teammarhaba.backend.membership.CheckoutResult;
import com.teammarhaba.backend.membership.CheckoutService;
import com.teammarhaba.backend.membership.Entitlement;
import com.teammarhaba.backend.membership.EntitlementService;
import java.util.Set;
import org.springframework.data.domain.Sort;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
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
 *   <li>{@code GET /events/{id}/entitlement} — the caller's membership entitlement to this event
 *       (TM-476): {@code decision} ({@code FREE|INCLUDED|PAY|UPGRADE}), {@code amountPence} and a
 *       {@code reason} code. The authoritative source the checkout screen (TM-479) consumes so that
 *       the price shown and what RSVP charges always agree.</li>
 *   <li>{@code POST /events/{id}/checkout} — RSVP checkout (TM-477): resolves the entitlement then
 *       records an order. {@code FREE}/{@code INCLUDED} confirm frictionlessly (£0 order, RSVP lands;
 *       first-event credit consumed on commitment); {@code PAY} records a {@code PENDING} order and
 *       returns {@code paymentRequired} (settled later by TM-478); {@code UPGRADE} is a {@code 403}.
 *       Idempotent per (user, event).</li>
 *   <li>{@code POST /events/{id}/checkout/cancel} — reverse a checkout (TM-477): leaves the event and,
 *       inside the cancellation window, returns the first-event credit and marks the order
 *       cancelled/refundable; outside it, the credit/charge is forfeited.</li>
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
    private final EntitlementService entitlements;
    private final CheckoutService checkout;

    EventController(
            EventQueryService queries,
            EventRsvpService rsvps,
            EntitlementService entitlements,
            CheckoutService checkout) {
        this.queries = queries;
        this.rsvps = rsvps;
        this.entitlements = entitlements;
        this.checkout = checkout;
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

    /**
     * RSVP (or re-RSVP, idempotently). Returns where the caller landed plus fresh counts.
     *
     * <p>Paid-event gate (TM-625): while the server-side membership flag is on, a fresh join on an
     * event whose entitlement resolves to {@code PAY} is a {@code 402 Payment Required} unless the
     * caller already holds a settled order — the join must go through {@code /checkout} so the money
     * settles first. Flag off: ungated, exactly the pre-membership behaviour.
     */
    @PostMapping("/events/{id}/rsvp")
    RsvpResult rsvp(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return rsvps.rsvp(caller, id);
    }

    /**
     * Leave the event (idempotent). Returns a {@link CancelResult}: whether leaving now counts as a
     * <b>late cancellation</b> (TM-414 — inside the event's cancellation window, default 24h before
     * start), the running strike count, and an honest message to show ({@code null} for an early or
     * no-op cancel, which is free and silent).
     *
     * <p>{@code ?preview=true} runs a non-committing pre-confirm: it reports the same verdict and the
     * count the caller <em>would</em> reach, but does not leave the event or record a strike — the
     * check the UI makes before asking the user to confirm. (A deliberate dry-run on the DELETE verb,
     * same spirit as a {@code dryRun} flag; it keeps the whole pre-confirm on the un-RSVP path.)
     */
    @DeleteMapping("/events/{id}/rsvp")
    CancelResult cancelRsvp(
            @AuthenticationPrincipal VerifiedUser caller,
            @PathVariable Long id,
            @RequestParam(defaultValue = "false") boolean preview) {
        return rsvps.cancelRsvp(caller, id, preview);
    }

    /**
     * Claim an open spot from the waitlist — first-claim-wins, capacity-safe. Subject to the same
     * TM-625 paid-event gate as RSVP: promoting into a {@code PAY} event without a settled order is a
     * {@code 402} (a paid-up member whose settled order landed them waitlisted claims normally).
     */
    @PostMapping("/events/{id}/claim")
    RsvpResult claim(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return rsvps.claim(caller, id);
    }

    /**
     * The caller's membership entitlement to this event (TM-476): whether it is {@code FREE}
     * (first-event credit / a genuinely free event), {@code INCLUDED} (their tier covers it), or
     * {@code PAY} the returned {@code amountPence} (standard or premium price), with a {@code reason}
     * code. The account is JIT-enrolled onto {@code PAY_PER_EVENT} on first sight (TM-474). A hidden
     * event is a {@code 404}, exactly as the detail route. This resolver is authoritative — the checkout
     * screen (TM-479) consumes it instead of re-deriving the rule client-side, so display and RSVP agree.
     */
    @GetMapping("/events/{id}/entitlement")
    Entitlement entitlement(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return entitlements.resolve(caller, id);
    }

    /**
     * Check out an RSVP (TM-477): resolve the caller's entitlement, then record an order and confirm.
     * {@code FREE}/{@code INCLUDED} are frictionless — a £0 {@code CONFIRMED} order and the RSVP lands
     * (on a first-event {@code FREE} the credit is consumed on commitment); {@code PAY} records a
     * {@code PENDING} order and returns {@code paymentRequired} (the charge is stubbed — the Revolut
     * settle is TM-478), leaving the RSVP unconfirmed until payment; an {@code UPGRADE} entitlement is a
     * {@code 403}. Idempotent per (user, event) — a repeat returns the existing order, never a duplicate.
     * A hidden event is a {@code 404}, exactly as the other routes.
     */
    @PostMapping("/events/{id}/checkout")
    CheckoutResult checkout(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return checkout.checkout(caller, id);
    }

    /**
     * Cancel a checkout (TM-477): always leaves the event, and — inside the cancellation window (per-event,
     * default 24h before start, the same TM-414 window as {@code DELETE /rsvp}) — reverses the commitment,
     * returning the first-event credit (if this event consumed it) and moving the order to
     * {@code CANCELLED}/{@code REFUND_DUE} (the money refund itself is TM-478). Missing the window forfeits
     * the credit/charge even though the caller leaves. Idempotent. A {@code 409} once the event has started.
     */
    @PostMapping("/events/{id}/checkout/cancel")
    CheckoutCancelResult cancelCheckout(@AuthenticationPrincipal VerifiedUser caller, @PathVariable Long id) {
        return checkout.cancel(caller, id);
    }
}
