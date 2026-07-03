package com.teammarhaba.backend.event;

import java.time.Instant;
import java.util.List;

/**
 * The full event-detail view ({@code GET /api/v1/events/{id}}, TM-393): everything the card has
 * plus the body text, links, both counts, the first-N attendee-avatar strip (join order, resolved
 * through {@code User} so tombstoned accounts drop out) and the caller's own state.
 *
 * <p>{@code spotAvailableToClaim} is the offer-cascade affordance: {@code true} only when the
 * caller is {@code WAITLISTED}, holds a <em>live offer</em> ({@code offer_notified_at} stamped by
 * TM-397's cascade and not yet voided) <em>and</em> a free spot still exists. It is the signal the
 * client turns into the "claim your spot" call-to-action for {@code POST /events/{id}/claim}.
 *
 * @param id                   the event id
 * @param heading              short display title
 * @param description          full body text
 * @param locationText         free-text venue line
 * @param mapUrl               optional map-pin link
 * @param onlineUrl            optional join link for online/hybrid events
 * @param timezone             IANA timezone id pairing with the instants
 * @param startAt              when the event starts (UTC)
 * @param endAt                optional end instant; {@code null} = open-ended
 * @param capacity             max GOING attendees; {@code null} = unlimited
 * @param imagePath            optional storage path of the event image
 * @param goingCount           attendees currently holding a GOING spot
 * @param waitlistedCount      attendees queued on the FIFO waitlist
 * @param attendees            the first N GOING attendees in join order (the avatar strip)
 * @param myState              the caller's own state on this event
 * @param spotAvailableToClaim {@code true} when an open spot and a live offer exist for the caller
 */
public record EventDetail(
        Long id,
        String heading,
        String description,
        String locationText,
        String mapUrl,
        String onlineUrl,
        String timezone,
        Instant startAt,
        Instant endAt,
        Integer capacity,
        String imagePath,
        long goingCount,
        long waitlistedCount,
        List<AttendeeAvatar> attendees,
        MyState myState,
        boolean spotAvailableToClaim) {}
