package com.teammarhaba.backend.event;

import com.fasterxml.jackson.annotation.JsonInclude;
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
 * <p><b>Location reveal (TM-408)</b> — the three exact-location fields ({@code locationText},
 * {@code mapUrl}, {@code onlineUrl}) are a server-side privacy guard: they are populated only once
 * {@code locationRevealed} is {@code true} ({@code now >= startAt − revealHours}) and are otherwise
 * <b>absent</b> from the JSON ({@link JsonInclude.Include#NON_NULL}), never merely blanked. Before
 * reveal the client shows the coarse {@code city} hint plus {@code locationRevealsAt}. The guard is
 * uniform for every caller — GOING and WAITLISTED attendees see exactly the same withholding.
 *
 * <p><b>Age band (TM-415)</b> — {@code ageMin}/{@code ageMax} carry the event's target age group for
 * display ({@code null}/{@code null} = open to all ages); {@code ageEligible} is the caller's own
 * verdict — {@code null} when the event is unrestricted, else {@code true}/{@code false} from
 * {@code AgeEligibilityPolicy} (an unset age on a banded event is {@code false}). The client uses it
 * to disable RSVP with honest copy without needing to know the server-side ±tolerance grace.
 *
 * @param id                   the event id
 * @param heading              short display title
 * @param description          full body text
 * @param locationText         exact venue line — present only once revealed, else absent
 * @param mapUrl               exact map-pin link — present only once revealed, else absent
 * @param onlineUrl            exact join link — present only once revealed, else absent
 * @param city                 coarse locality hint (may be {@code null}); safe to show pre-reveal
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
 * @param locationRevealed     whether the exact location is public yet
 * @param locationRevealsAt    the instant the exact location becomes public ({@code startAt − revealHours})
 * @param status               the temporal phase (TM-412); {@code UPCOMING} or {@code HAPPENING_NOW}
 *     — a finished event's detail 404s, so {@code FINISHED} is never returned here
 * @param happeningNow         convenience flag ({@code status == HAPPENING_NOW}) for the live badge
 * @param ageMin               lower edge of the target age band ({@code null} = no lower bound)
 * @param ageMax               upper edge of the target age band ({@code null} = no upper bound;
 *     both {@code null} = open to all ages)
 * @param ageEligible          the caller's eligibility verdict: {@code null} = unrestricted event,
 *     else {@code true}/{@code false} (age unset ⇒ {@code false})
 */
public record EventDetail(
        Long id,
        String heading,
        String description,
        @JsonInclude(JsonInclude.Include.NON_NULL) String locationText,
        @JsonInclude(JsonInclude.Include.NON_NULL) String mapUrl,
        @JsonInclude(JsonInclude.Include.NON_NULL) String onlineUrl,
        String city,
        String timezone,
        Instant startAt,
        Instant endAt,
        Integer capacity,
        String imagePath,
        long goingCount,
        long waitlistedCount,
        List<AttendeeAvatar> attendees,
        MyState myState,
        boolean spotAvailableToClaim,
        boolean locationRevealed,
        Instant locationRevealsAt,
        EventPhase status,
        boolean happeningNow,
        Integer ageMin,
        Integer ageMax,
        Boolean ageEligible) {}
