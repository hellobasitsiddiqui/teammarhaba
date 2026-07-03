package com.teammarhaba.backend.api;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.teammarhaba.backend.event.EventDraft;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.time.ZoneId;

/**
 * Body for {@code POST /api/v1/admin/events} (TM-392). Field caps mirror the {@code events}
 * columns (V11/V12); the cross-field rules ({@code visibilityStart < visibilityEnd},
 * {@code endAt > startAt}, IANA timezone) are {@code @AssertTrue} properties so every violation
 * surfaces through the standard RFC-7807 validation body. {@code mapUrl} and {@code onlineUrl} are
 * both optional and independent — an event may have neither, either, or both.
 *
 * <p>{@code imagePath} is the Firebase Storage object path of an already-uploaded event image
 * (house avatar pattern, TM-166: the client uploads {@code event-images/{eventId}} directly to
 * Storage — admin-only per {@code storage.rules} — and the backend persists only the path). It is
 * normally set by a follow-up PATCH, because the id doesn't exist before creation.
 *
 * @param heading         short display title (≤ 120)
 * @param description     full body text (≤ 5000)
 * @param locationText    free-text venue line, always present — "Online" for online events (≤ 500)
 * @param mapUrl          optional map-pin link (≤ 2048)
 * @param onlineUrl       optional join link for online/hybrid events (≤ 2048)
 * @param city            optional coarse locality (≤ 120); the pre-reveal public hint + per-city
 *     reveal-default key (TM-408)
 * @param timezone        IANA timezone id of the event's locale (e.g. {@code Europe/London})
 * @param startAt         when the event starts (UTC instant)
 * @param endAt           optional end instant; omitted = open-ended
 * @param visibilityStart from when the event appears in the public listing
 * @param visibilityEnd   until when it appears
 * @param capacity        max GOING attendees, ≥ 1; omitted = unlimited
 * @param imagePath       optional storage path of the event image ({@code event-images/…})
 * @param locationRevealHours optional per-event reveal window in hours before start (1..8760);
 *     omitted = inherit the per-city / app default (TM-408)
 */
public record CreateEventRequest(
        @NotBlank @Size(max = 120) String heading,
        @NotBlank @Size(max = 5000) String description,
        @NotBlank @Size(max = 500) String locationText,
        @Size(max = 2048) String mapUrl,
        @Size(max = 2048) String onlineUrl,
        @Size(max = 120) String city,
        @NotBlank @Size(max = 64) String timezone,
        @NotNull Instant startAt,
        Instant endAt,
        @NotNull Instant visibilityStart,
        @NotNull Instant visibilityEnd,
        @Min(1) Integer capacity,
        @Size(max = 512)
                @Pattern(
                        regexp = "event-images/[A-Za-z0-9._-]+",
                        message = "must be a storage object path like event-images/{eventId}")
                String imagePath,
        @Min(1) @Max(8760) Integer locationRevealHours) {

    /** The timezone must be a real IANA zone id — bad ids would break every client's rendering. */
    @JsonIgnore
    @AssertTrue(message = "timezone must be a valid IANA timezone id (e.g. Europe/London)")
    public boolean isTimezoneValid() {
        return timezone == null || timezone.isBlank() || ZoneId.getAvailableZoneIds().contains(timezone);
    }

    /** Every event has an explicit, ordered visibility window. */
    @JsonIgnore
    @AssertTrue(message = "visibilityStart must be before visibilityEnd")
    public boolean isVisibilityWindowOrdered() {
        return visibilityStart == null || visibilityEnd == null || visibilityStart.isBefore(visibilityEnd);
    }

    /** An end, when given, must come after the start. */
    @JsonIgnore
    @AssertTrue(message = "endAt must be after startAt")
    public boolean isEndAfterStart() {
        return endAt == null || startAt == null || endAt.isAfter(startAt);
    }

    /** Map onto the domain-side command object ({@code event} package stays free of api DTOs). */
    EventDraft toDraft() {
        return new EventDraft(
                heading,
                description,
                locationText,
                mapUrl,
                onlineUrl,
                city,
                timezone,
                startAt,
                endAt,
                visibilityStart,
                visibilityEnd,
                capacity,
                imagePath,
                locationRevealHours);
    }
}
