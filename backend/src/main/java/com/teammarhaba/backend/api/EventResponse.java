package com.teammarhaba.backend.api;

import com.teammarhaba.backend.event.BookingCutoffPolicy;
import com.teammarhaba.backend.event.CancellationPolicy;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.LocationRevealPolicy;
import java.time.Instant;

/**
 * An event as exposed by the admin events API (TM-392). A deliberate <em>projection</em> of
 * {@link Event}: everything the admin console needs to list, edit and cancel events — including
 * lifecycle facts the public listing would hide (a not-yet-visible window, a {@code CANCELLED}
 * status) — and none of the internals ({@code version}, {@code deletedAt}).
 *
 * <p>All instants are UTC; clients pair them with {@code timezone} (IANA id) to render local
 * times — the backend never converts (TM-391 time model).
 *
 * <p>Unlike the public views, the admin projection always carries the <em>exact</em> location —
 * the console manages the full record. It also surfaces the TM-408 reveal policy so the create/edit
 * form can prefill: {@code locationRevealHours} is the raw per-event override ({@code null} =
 * inherit), {@code effectiveLocationRevealHours} is what actually applies after the
 * override→city→app fallback, and {@code locationRevealsAt} is when the public reveal happens.
 *
 * <p>The booking-cutoff (TM-413) and cancellation-window (TM-414) policies are surfaced the same
 * way (TM-523), so the admin form can both prefill the raw override and show what actually applies:
 * {@code bookingCutoffHours} / {@code cancellationWindowHours} are the raw per-event overrides
 * ({@code null} = inherit), {@code effectiveBookingCutoffHours} / {@code effectiveCancellationWindowHours}
 * are what resolve after the override→city→app fallback, and {@code bookingCutoffAt} /
 * {@code cancellationWindowOpensAt} are the boundary instants those windows imply.
 *
 * @param id                           database id — the handle for the {@code /admin/events/{id}} endpoints
 * @param heading                      short display title
 * @param description                  full body text
 * @param locationText                 free-text venue line ("Online" for online events)
 * @param mapUrl                       optional map-pin link ({@code null} when none)
 * @param onlineUrl                    optional join link ({@code null} for in-person only)
 * @param city                         coarse locality; the pre-reveal public hint + per-city default key
 * @param timezone                     IANA timezone id the instants pair with
 * @param startAt                      start instant (UTC)
 * @param endAt                        optional end instant ({@code null} = open-ended)
 * @param visibilityStart              from when the event appears in the public listing
 * @param visibilityEnd                until when it appears
 * @param capacity                     max GOING attendees ({@code null} = unlimited)
 * @param imagePath                    storage path of the event image ({@code null} = themed placeholder)
 * @param locationRevealHours          per-event reveal override in hours ({@code null} = inherit)
 * @param effectiveLocationRevealHours the reveal window actually applied (override → city → app default)
 * @param locationRevealsAt            when the exact location goes public ({@code startAt − effective hours})
 * @param bookingCutoffHours           per-event booking-cutoff override in hours ({@code null} = inherit) — TM-413/TM-523
 * @param effectiveBookingCutoffHours  the cutoff window actually applied (override → city → app default)
 * @param bookingCutoffAt              when new joins stop being accepted ({@code startAt − effective hours})
 * @param cancellationWindowHours      per-event cancellation-window override in hours ({@code null} = inherit) — TM-414/TM-523
 * @param effectiveCancellationWindowHours the cancellation window actually applied (override → city → app default)
 * @param cancellationWindowOpensAt    when an un-RSVP starts counting as late ({@code startAt − effective hours})
 * @param ageMin                       lower edge of the target age band ({@code null} = no lower bound)
 * @param ageMax                       upper edge of the target age band ({@code null} = no upper bound;
 *     both {@code null} = open to all ages) — TM-415
 * @param pricePence                   ticket price in pence (minor units, GBP); {@code 0} = free — TM-475
 * @param premium                      whether the event is gated as premium — TM-475
 * @param status                       {@code PUBLISHED} or {@code CANCELLED}
 * @param past                         whether the event has already ended (TM-518) — the temporal
 *     {@link com.teammarhaba.backend.event.EventPhasePolicy#isFinished finished} verdict, not the
 *     admin status. Drives the console's "Past events" grouping and the hidden/disabled edit + cancel
 *     controls, kept in lock-step with the server-side edit/cancel reject so the two never disagree
 * @param createdBy                    {@code users.id} of the creating admin
 * @param createdAt                    DB-authoritative creation instant
 * @param updatedAt                    last mutation instant
 * @param goingCount                   number of {@code GOING} attendees ({@code null} = not computed
 *     on this path — the create/cancel responses, which aren't a count display) — TM-430
 * @param waitlistCount                number of {@code WAITLISTED} attendees ({@code null} as above) — TM-430
 */
public record EventResponse(
        Long id,
        String heading,
        String description,
        String locationText,
        String mapUrl,
        String onlineUrl,
        String city,
        String timezone,
        Instant startAt,
        Instant endAt,
        Instant visibilityStart,
        Instant visibilityEnd,
        Integer capacity,
        String imagePath,
        Integer locationRevealHours,
        int effectiveLocationRevealHours,
        Instant locationRevealsAt,
        Integer bookingCutoffHours,
        int effectiveBookingCutoffHours,
        Instant bookingCutoffAt,
        Integer cancellationWindowHours,
        int effectiveCancellationWindowHours,
        Instant cancellationWindowOpensAt,
        Integer ageMin,
        Integer ageMax,
        int pricePence,
        boolean premium,
        String status,
        boolean past,
        Long createdBy,
        Instant createdAt,
        Instant updatedAt,
        Long goingCount,
        Long waitlistCount) {

    /**
     * Projection WITHOUT attendance counts — the create/cancel responses, which the console doesn't
     * render as a count display (it navigates back to the list, which reloads with real counts). The
     * counts come back {@code null} here, distinguishing "not computed" from a real {@code 0}.
     */
    public static EventResponse from(
            Event event,
            LocationRevealPolicy reveal,
            BookingCutoffPolicy cutoff,
            CancellationPolicy cancellation,
            boolean past) {
        return from(event, reveal, cutoff, cancellation, past, null, null);
    }

    /**
     * Projection WITH attendance counts (TM-430) — the list and single-GET display paths. The caller
     * supplies the counts (batch-tallied for the list, per-state for the single event) so the admin
     * console can show "N going / M waitlist" instead of "— / —". The three policies resolve the
     * effective reveal / booking-cutoff / cancellation windows (raw override → city → app default) so
     * the admin form can prefill both the raw override and what actually applies (TM-408/TM-523).
     * {@code past} is the caller-computed
     * {@link com.teammarhaba.backend.event.EventPhasePolicy#isFinished} verdict (TM-518) — passed in
     * rather than derived here so this stays a pure, time-independent mapper and "now" is fixed once
     * per request in the controller.
     */
    public static EventResponse from(
            Event event,
            LocationRevealPolicy reveal,
            BookingCutoffPolicy cutoff,
            CancellationPolicy cancellation,
            boolean past,
            Long goingCount,
            Long waitlistCount) {
        return new EventResponse(
                event.getId(),
                event.getHeading(),
                event.getDescription(),
                event.getLocationText(),
                event.getMapUrl(),
                event.getOnlineUrl(),
                event.getCity(),
                event.getTimezone(),
                event.getStartAt(),
                event.getEndAt(),
                event.getVisibilityStart(),
                event.getVisibilityEnd(),
                event.getCapacity(),
                event.getImagePath(),
                event.getLocationRevealHours(),
                reveal.revealHoursFor(event),
                reveal.revealsAt(event),
                event.getBookingCutoffHours(),
                cutoff.cutoffHoursFor(event),
                cutoff.cutoffAt(event),
                event.getCancellationWindowHours(),
                cancellation.windowHoursFor(event),
                cancellation.windowOpensAt(event),
                event.getAgeMin(),
                event.getAgeMax(),
                event.getPricePence(),
                event.isPremium(),
                event.getStatus().name(),
                past,
                event.getCreatedBy(),
                event.getCreatedAt(),
                event.getUpdatedAt(),
                goingCount,
                waitlistCount);
    }
}
