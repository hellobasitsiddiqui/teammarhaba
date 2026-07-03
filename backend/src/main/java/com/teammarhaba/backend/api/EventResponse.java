package com.teammarhaba.backend.api;

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
 * @param status                       {@code PUBLISHED} or {@code CANCELLED}
 * @param createdBy                    {@code users.id} of the creating admin
 * @param createdAt                    DB-authoritative creation instant
 * @param updatedAt                    last mutation instant
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
        String status,
        Long createdBy,
        Instant createdAt,
        Instant updatedAt) {

    public static EventResponse from(Event event, LocationRevealPolicy reveal) {
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
                event.getStatus().name(),
                event.getCreatedBy(),
                event.getCreatedAt(),
                event.getUpdatedAt());
    }
}
