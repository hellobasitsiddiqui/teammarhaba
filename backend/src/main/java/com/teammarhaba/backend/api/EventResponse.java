package com.teammarhaba.backend.api;

import com.teammarhaba.backend.event.Event;
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
 * @param id              database id — the handle for the {@code /admin/events/{id}} endpoints
 * @param heading         short display title
 * @param description     full body text
 * @param locationText    free-text venue line ("Online" for online events)
 * @param mapUrl          optional map-pin link ({@code null} when none)
 * @param onlineUrl       optional join link ({@code null} for in-person only)
 * @param timezone        IANA timezone id the instants pair with
 * @param startAt         start instant (UTC)
 * @param endAt           optional end instant ({@code null} = open-ended)
 * @param visibilityStart from when the event appears in the public listing
 * @param visibilityEnd   until when it appears
 * @param capacity        max GOING attendees ({@code null} = unlimited)
 * @param imagePath       storage path of the event image ({@code null} = themed placeholder)
 * @param status          {@code PUBLISHED} or {@code CANCELLED}
 * @param createdBy       {@code users.id} of the creating admin
 * @param createdAt       DB-authoritative creation instant
 * @param updatedAt       last mutation instant
 */
public record EventResponse(
        Long id,
        String heading,
        String description,
        String locationText,
        String mapUrl,
        String onlineUrl,
        String timezone,
        Instant startAt,
        Instant endAt,
        Instant visibilityStart,
        Instant visibilityEnd,
        Integer capacity,
        String imagePath,
        String status,
        Long createdBy,
        Instant createdAt,
        Instant updatedAt) {

    public static EventResponse from(Event event) {
        return new EventResponse(
                event.getId(),
                event.getHeading(),
                event.getDescription(),
                event.getLocationText(),
                event.getMapUrl(),
                event.getOnlineUrl(),
                event.getTimezone(),
                event.getStartAt(),
                event.getEndAt(),
                event.getVisibilityStart(),
                event.getVisibilityEnd(),
                event.getCapacity(),
                event.getImagePath(),
                event.getStatus().name(),
                event.getCreatedBy(),
                event.getCreatedAt(),
                event.getUpdatedAt());
    }
}
