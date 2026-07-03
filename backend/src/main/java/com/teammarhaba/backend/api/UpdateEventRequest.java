package com.teammarhaba.backend.api;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.teammarhaba.backend.event.EventPatch;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.time.ZoneId;

/**
 * Body for {@code PATCH /api/v1/admin/events/{id}} (TM-392). Partial update in the house PATCH
 * convention (TM-111's {@code UpdateUserRequest}): a {@code null}/omitted field is left unchanged.
 * Consequence (documented trade-off): an optional field cannot be cleared back to {@code null}
 * through this API yet.
 *
 * <p>Per-field caps match {@code CreateEventRequest}; required-on-create fields additionally
 * reject a <em>blank</em> value here (present-but-empty is never meaningful). Cross-field rules
 * that need the merged state ({@code visibilityStart < visibilityEnd}, {@code endAt > startAt}
 * when the patch carries only one side) are re-checked by {@code EventAdminService} on the merged
 * entity — bean validation at the edge can only see what the request carries.
 */
public record UpdateEventRequest(
        @Size(max = 120) String heading,
        @Size(max = 5000) String description,
        @Size(max = 500) String locationText,
        @Size(max = 2048) String mapUrl,
        @Size(max = 2048) String onlineUrl,
        @Size(max = 120) String city,
        @Size(max = 64) String timezone,
        Instant startAt,
        Instant endAt,
        Instant visibilityStart,
        Instant visibilityEnd,
        @Min(1) Integer capacity,
        @Size(max = 512)
                @Pattern(
                        regexp = "event-images/[A-Za-z0-9._-]+",
                        message = "must be a storage object path like event-images/{eventId}")
                String imagePath,
        @Min(1) @Max(8760) Integer locationRevealHours,
        @Min(13) @Max(120) Integer ageMin,
        @Min(13) @Max(120) Integer ageMax) {

    @JsonIgnore
    @AssertTrue(message = "heading must not be blank")
    public boolean isHeadingUsable() {
        return heading == null || !heading.isBlank();
    }

    @JsonIgnore
    @AssertTrue(message = "description must not be blank")
    public boolean isDescriptionUsable() {
        return description == null || !description.isBlank();
    }

    @JsonIgnore
    @AssertTrue(message = "locationText must not be blank")
    public boolean isLocationTextUsable() {
        return locationText == null || !locationText.isBlank();
    }

    /** When a timezone is sent it must be a real IANA id (blank is implicitly rejected too). */
    @JsonIgnore
    @AssertTrue(message = "timezone must be a valid IANA timezone id (e.g. Europe/London)")
    public boolean isTimezoneValid() {
        return timezone == null || ZoneId.getAvailableZoneIds().contains(timezone);
    }

    /** Ordering enforced here only when the patch carries both sides; the merged check is the service's. */
    @JsonIgnore
    @AssertTrue(message = "visibilityStart must be before visibilityEnd")
    public boolean isVisibilityWindowOrdered() {
        return visibilityStart == null || visibilityEnd == null || visibilityStart.isBefore(visibilityEnd);
    }

    @JsonIgnore
    @AssertTrue(message = "endAt must be after startAt")
    public boolean isEndAfterStart() {
        return endAt == null || startAt == null || endAt.isAfter(startAt);
    }

    /**
     * When the patch carries both age-band edges, the lower must not exceed the upper. The
     * merged-state check (patch carries only one edge, inverted against the persisted other side)
     * is {@code EventAdminService}'s, exactly like the visibility-window rule (TM-415).
     */
    @JsonIgnore
    @AssertTrue(message = "ageMin must be less than or equal to ageMax")
    public boolean isAgeBandOrdered() {
        return ageMin == null || ageMax == null || ageMin <= ageMax;
    }

    /** Map onto the domain-side command object ({@code event} package stays free of api DTOs). */
    EventPatch toPatch() {
        return new EventPatch(
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
                locationRevealHours,
                ageMin,
                ageMax);
    }
}
