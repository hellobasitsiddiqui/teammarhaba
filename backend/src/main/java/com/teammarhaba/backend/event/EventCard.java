package com.teammarhaba.backend.event;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/**
 * One row of the visible-now listing ({@code GET /api/v1/events}, TM-393) — the card fields plus
 * the two live badges: how many are going and where the caller stands. Follows the
 * {@code UserSummary} convention: a list row carries only what the card renders, never the full
 * entity. Instants are UTC; clients pair them with {@code timezone} (IANA id) to display local
 * times, DST-correctly.
 *
 * <p><b>Location reveal (TM-408)</b> — {@code locationText} is the <em>exact</em> venue and is a
 * server-side privacy guard: it is only populated once {@code locationRevealed} is {@code true}
 * ({@code now >= startAt − revealHours}) and is otherwise <b>absent</b> from the JSON
 * ({@link JsonInclude.Include#NON_NULL}), never merely blanked. Before reveal the client shows the
 * coarse {@code city} hint and {@code locationRevealsAt}; the guard is uniform for every caller,
 * GOING/WAITLISTED included.
 *
 * @param id                the event id (detail link)
 * @param heading           short display title
 * @param locationText      exact venue line — present only once revealed, else absent
 * @param city              coarse locality hint (may be {@code null}); safe to show pre-reveal
 * @param timezone          IANA timezone id pairing with the instants
 * @param startAt           when the event starts (UTC)
 * @param endAt             optional end instant; {@code null} = open-ended
 * @param capacity          max GOING attendees; {@code null} = unlimited
 * @param imagePath         optional storage path of the event image; {@code null} = themed placeholder
 * @param goingCount        number of attendees currently holding a GOING spot
 * @param myState           the caller's own state on this event
 * @param locationRevealed  whether the exact location is public yet
 * @param locationRevealsAt the instant the exact location becomes public ({@code startAt − revealHours})
 * @param status            the temporal phase (TM-412); on the listing only {@code UPCOMING} or
 *     {@code HAPPENING_NOW} — finished events are excluded from it
 * @param happeningNow      convenience flag ({@code status == HAPPENING_NOW}); the "Happening now"
 *     badge the client renders and the signal it groups live cards by
 */
public record EventCard(
        Long id,
        String heading,
        @JsonInclude(JsonInclude.Include.NON_NULL) String locationText,
        String city,
        String timezone,
        Instant startAt,
        Instant endAt,
        Integer capacity,
        String imagePath,
        long goingCount,
        MyState myState,
        boolean locationRevealed,
        Instant locationRevealsAt,
        EventPhase status,
        boolean happeningNow) {}
