package com.teammarhaba.backend.event;

import java.time.Instant;

/**
 * Command object for creating an event through the admin API (TM-392) — the domain-side shape the
 * {@code api} package's {@code CreateEventRequest} maps onto, so this package never depends on the
 * HTTP DTOs (mirrors {@code ProfileUpdate} in the {@code user} package). Values arrive already
 * bean-validated at the API edge; the optional fields ({@code mapUrl}, {@code onlineUrl},
 * {@code endAt}, {@code capacity}, {@code imagePath}, {@code city}, {@code locationRevealHours})
 * are {@code null} when absent. {@code city} is the coarse locality (pre-reveal hint + per-city
 * default key); {@code locationRevealHours} is the per-event reveal-window override ({@code null}
 * = inherit the city/app default) — both TM-408. {@code bookingCutoffHours} (TM-413) and
 * {@code cancellationWindowHours} (TM-414) are the per-event booking-cutoff / cancellation-window
 * overrides, each {@code null} = inherit the city/app default; {@code 0} is a meaningful override
 * (bookable up to the start / never a late cancel), not "unset" (TM-523). {@code ageMin}/{@code ageMax} are the optional
 * age-group band (TM-415); both {@code null} = open to all ages. {@code pricePence} is the ticket
 * price in pence and {@code premium} the premium-gating flag (TM-475); both are {@code null} when the
 * admin omitted them on create, in which case {@link EventAdminService} leaves the entity defaults
 * (£5 / not premium) in place. {@code venueId} optionally references a reusable venue (TM-519);
 * {@code null} = a one-off free-text location — {@code locationText} stays the display line either way.
 * {@code openingMessage} is the optional group-chat opening message (TM-710); {@code null}/blank = none,
 * otherwise auto-posted once as an announcement when the event's chat first opens.
 */
public record EventDraft(
        String heading,
        String description,
        String locationText,
        String mapUrl,
        String onlineUrl,
        String city,
        Long venueId,
        String timezone,
        Instant startAt,
        Instant endAt,
        Instant visibilityStart,
        Instant visibilityEnd,
        Integer capacity,
        String imagePath,
        Integer locationRevealHours,
        Integer bookingCutoffHours,
        Integer cancellationWindowHours,
        Integer ageMin,
        Integer ageMax,
        Integer pricePence,
        Boolean premium,
        String openingMessage) {}
