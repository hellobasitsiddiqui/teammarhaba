package com.teammarhaba.backend.event;

import java.time.Instant;

/**
 * One row of the visible-now listing ({@code GET /api/v1/events}, TM-393) — the card fields plus
 * the two live badges: how many are going and where the caller stands. Follows the
 * {@code UserSummary} convention: a list row carries only what the card renders, never the full
 * entity. Instants are UTC; clients pair them with {@code timezone} (IANA id) to display local
 * times, DST-correctly.
 *
 * @param id           the event id (detail link)
 * @param heading      short display title
 * @param locationText free-text venue line (always present, "Online" for online events)
 * @param timezone     IANA timezone id pairing with the instants
 * @param startAt      when the event starts (UTC)
 * @param endAt        optional end instant; {@code null} = open-ended
 * @param capacity     max GOING attendees; {@code null} = unlimited
 * @param imagePath    optional storage path of the event image; {@code null} = themed placeholder
 * @param goingCount   number of attendees currently holding a GOING spot
 * @param myState      the caller's own state on this event
 */
public record EventCard(
        Long id,
        String heading,
        String locationText,
        String timezone,
        Instant startAt,
        Instant endAt,
        Integer capacity,
        String imagePath,
        long goingCount,
        MyState myState) {}
