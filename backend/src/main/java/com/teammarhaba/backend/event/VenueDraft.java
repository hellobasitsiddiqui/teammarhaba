package com.teammarhaba.backend.event;

/**
 * Command object for creating a {@link Venue} through the admin API (TM-519) — the domain-side shape
 * the {@code api} package's {@code CreateVenueRequest} maps onto, so this package never depends on
 * the HTTP DTOs (mirrors {@link EventDraft}). Values arrive already bean-validated at the API edge;
 * the optional detail fields are {@code null} when absent. {@code name} and {@code addressLine} are
 * the only required fields.
 */
public record VenueDraft(
        String name,
        String addressLine,
        String city,
        Double latitude,
        Double longitude,
        String mapUrl,
        String notes,
        Integer capacity,
        String accessibility,
        String parking,
        IndoorOutdoor indoorOutdoor,
        String photoPath) {}
