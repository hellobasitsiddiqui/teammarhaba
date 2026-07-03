package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;

/**
 * Verifies the {@code events} mapping against a real Postgres (Testcontainers): the context booting
 * at all proves Hibernate {@code validate} agrees with the {@code V11__create_events} migration,
 * and the tests cover the round-trip (UTC instants + IANA timezone string), the visible-now
 * listing's window/status filtering, and the house soft-delete convention.
 *
 * <p>The suite shares one database across test classes, so assertions use contains/doesNotContain
 * on this class's own rows rather than exact table contents.
 */
class EventRepositoryIntegrationTest extends AbstractIntegrationTest {

    private static final Pageable SOONEST_FIRST = PageRequest.of(0, 100, Sort.by("startAt").ascending());

    @Autowired
    private EventRepository events;

    @Autowired
    private UserRepository users;

    private Long creatorId;

    @BeforeEach
    void seedCreator() {
        creatorId = users.findByFirebaseUid("event-creator-uid")
                .orElseGet(() -> users.save(new User("event-creator-uid", "creator@example.com", "Creator")))
                .getId();
    }

    private Event newEvent(String heading, Instant visibilityStart, Instant visibilityEnd) {
        Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
        return new Event(
                heading,
                "A friendly meetup.",
                "Marhaba Cafe, 12 High St",
                "Europe/London",
                now.plus(Duration.ofDays(7)),
                visibilityStart,
                visibilityEnd,
                creatorId,
                now);
    }

    @Test
    void persistsAndRoundTripsUtcInstantsPlusIanaTimezoneWithHouseDefaults() {
        Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
        Event toSave = newEvent("Round trip", now.minus(Duration.ofHours(1)), now.plus(Duration.ofDays(30)));
        toSave.setMapUrl("https://maps.example.com/pin/42");
        toSave.setOnlineUrl("https://meet.example.com/marhaba");
        toSave.setEndAt(now.plus(Duration.ofDays(7)).plus(Duration.ofHours(2)));
        toSave.setCapacity(25);
        toSave.setImagePath("events/round-trip.png");
        Long id = events.save(toSave).getId();

        assertThat(id).isNotNull();
        Event saved = events.findById(id).orElseThrow();
        // Times: UTC instants round-trip exactly; the IANA timezone rides along as a plain string —
        // rendering local time is the client's job, the backend never converts.
        assertThat(saved.getStartAt()).isEqualTo(toSave.getStartAt());
        assertThat(saved.getEndAt()).isEqualTo(toSave.getEndAt());
        assertThat(saved.getTimezone()).isEqualTo("Europe/London");
        // House defaults/conventions: PUBLISHED, active, version 0, DB-authoritative created_at.
        assertThat(saved.getStatus()).isEqualTo(EventStatus.PUBLISHED);
        assertThat(saved.isPublished()).isTrue();
        assertThat(saved.isDeleted()).isFalse();
        assertThat(saved.getVersion()).isZero();
        assertThat(saved.getCreatedAt()).isNotNull();
        assertThat(saved.getCreatedBy()).isEqualTo(creatorId);
        // Optional fields round-trip.
        assertThat(saved.getMapUrl()).isEqualTo("https://maps.example.com/pin/42");
        assertThat(saved.getOnlineUrl()).isEqualTo("https://meet.example.com/marhaba");
        assertThat(saved.getCapacity()).isEqualTo(25);
        assertThat(saved.hasCapacityLimit()).isTrue();
        assertThat(saved.getImagePath()).isEqualTo("events/round-trip.png");
    }

    @Test
    void unlimitedCapacityIsNull() {
        Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
        Long id = events.save(newEvent("No cap", now, now.plus(Duration.ofDays(1)))).getId();

        Event saved = events.findById(id).orElseThrow();
        assertThat(saved.getCapacity()).isNull();
        assertThat(saved.hasCapacityLimit()).isFalse();
    }

    @Test
    void visibleNowListingFiltersOnWindowAndStatus() {
        Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
        Long visible = events.save(newEvent(
                        "In window", now.minus(Duration.ofHours(1)), now.plus(Duration.ofHours(1))))
                .getId();
        Long notYet = events.save(newEvent(
                        "Not yet visible", now.plus(Duration.ofHours(1)), now.plus(Duration.ofDays(2))))
                .getId();
        Long expired = events.save(newEvent(
                        "Window over", now.minus(Duration.ofDays(2)), now.minus(Duration.ofHours(1))))
                .getId();
        Event cancelled = newEvent("Cancelled", now.minus(Duration.ofHours(1)), now.plus(Duration.ofHours(1)));
        cancelled.cancel(now);
        Long cancelledId = events.save(cancelled).getId();

        List<Long> visibleIds = events.findVisibleAt(now, EventStatus.PUBLISHED, SOONEST_FIRST).stream()
                .map(Event::getId)
                .toList();

        assertThat(visibleIds).contains(visible).doesNotContain(notYet, expired, cancelledId);
    }

    @Test
    void cancellingDropsAnEventFromTheListingButKeepsItReadable() {
        Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
        Long id = events.save(newEvent("To cancel", now.minus(Duration.ofHours(1)), now.plus(Duration.ofDays(1))))
                .getId();
        assertThat(events.findVisibleAt(now, EventStatus.PUBLISHED, SOONEST_FIRST))
                .extracting(Event::getId)
                .contains(id);

        Event event = events.findById(id).orElseThrow();
        event.cancel(now);
        events.save(event);

        assertThat(events.findVisibleAt(now, EventStatus.PUBLISHED, SOONEST_FIRST))
                .extracting(Event::getId)
                .doesNotContain(id);
        // Still readable directly — cancelled is a status, not a deletion.
        assertThat(events.findById(id))
                .get()
                .satisfies(e -> assertThat(e.getStatus()).isEqualTo(EventStatus.CANCELLED));
    }

    @Test
    void softDeleteHidesTheEventFromAllNormalQueries() {
        Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
        Long id = events.save(newEvent("To delete", now.minus(Duration.ofHours(1)), now.plus(Duration.ofDays(1))))
                .getId();

        Event event = events.findById(id).orElseThrow();
        event.markDeleted(now);
        events.save(event);

        assertThat(events.findById(id)).isEmpty(); // @SQLRestriction hides the tombstone
        assertThat(events.findAll()).extracting(Event::getId).doesNotContain(id);
        assertThat(events.findVisibleAt(now, EventStatus.PUBLISHED, SOONEST_FIRST))
                .extracting(Event::getId)
                .doesNotContain(id);
    }

    @Test
    void optimisticLockVersionBumpsOnUpdate() {
        Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
        Long id = events.save(newEvent("Versioned", now, now.plus(Duration.ofDays(1)))).getId();

        Event event = events.findById(id).orElseThrow();
        long before = event.getVersion();
        event.setHeading("Versioned v2");
        event.touch(Instant.now().truncatedTo(ChronoUnit.MICROS));
        events.save(event);

        assertThat(events.findById(id).orElseThrow().getVersion()).isGreaterThan(before);
    }
}
