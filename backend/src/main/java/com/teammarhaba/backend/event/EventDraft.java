package com.teammarhaba.backend.event;

import java.time.Instant;

/**
 * Command object for creating an event through the admin API (TM-392) — the domain-side shape the
 * {@code api} package's {@code CreateEventRequest} maps onto, so this package never depends on the
 * HTTP DTOs (mirrors {@code ProfileUpdate} in the {@code user} package). Values arrive already
 * bean-validated at the API edge; the optional fields ({@code mapUrl}, {@code onlineUrl},
 * {@code endAt}, {@code capacity}, {@code imagePath}) are {@code null} when absent.
 */
public record EventDraft(
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
        String imagePath) {}
