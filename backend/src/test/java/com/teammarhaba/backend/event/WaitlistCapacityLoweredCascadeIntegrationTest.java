package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.notify.NotificationWriter;
import com.teammarhaba.backend.notify.PushDelivery;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushSender;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The capacity-shrink cascade-stop (TM-738 P1,
 * {@code cascadeVoidsStaleOffersWhenCapacityLoweredBelowGoing}): the defensive branch in
 * {@link WaitlistOfferCascadeService#sweepOpenOffers()} that voids a live offer once the event has
 * <em>no</em> free spot — reached here through the specific route the gap names, an admin lowering
 * an event's capacity <em>below</em> its GOING count. A member offered a spot on the (formerly)
 * full-but-freeing event must not be left holding a "spot available to claim" flag once the shrink
 * has taken every free spot away — a claim would 409, so the sweep clears the stale offer instead.
 *
 * <p>Distinct from {@code WaitlistOfferCascadeIntegrationTest#aSpotThatVanishesWithoutAClaimVoids…}:
 * that reaches {@code freeSpots <= 0} by seeding a GOING attendee up to capacity; this reaches it by
 * an admin edit that moves the capacity <em>under</em> a fixed GOING population — the exact
 * "capacity lowered below going" trigger the cascade's own comment cites (see {@code stampDueOffers}:
 * <q>capacity lowered below the GOING count</q>). Characterization only (adds no source).
 *
 * <p>Harness mirrors {@code WaitlistOfferCascadeIntegrationTest}: the service is built directly with a
 * mutable {@link Clock} (the house seam), the background sweep is off in the test profile, sweeps are
 * never {@code @Transactional} (they commit like production, which is what makes the stamp/void real),
 * the outermost {@link PushSender} is a recording fake, and every fixture is namespaced so it cannot
 * collide with a sibling suite on the shared Testcontainers DB.
 */
@Import(WaitlistCapacityLoweredCascadeIntegrationTest.RecordingSenderConfig.class)
class WaitlistCapacityLoweredCascadeIntegrationTest extends AbstractIntegrationTest {

    @Autowired private EventRepository events;
    @Autowired private EventAttendanceRepository attendance;
    @Autowired private OfferCascadeScanRepository scan;
    @Autowired private EventAttendeeNotifier notifier;
    @Autowired private UserRepository users;
    @Autowired private BookingCutoffPolicy bookingCutoff;
    @Autowired private PlatformTransactionManager txManager;
    @Autowired private NotificationWriter writer;
    @Autowired private EventAdminService admin;
    @Autowired private EventRsvpService rsvps;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private RecordingPushSender sender;

    private final MutableClock clock = new MutableClock(Instant.now());

    /** Per-test namespace on every firebase_uid so the DB-wide sweep cannot collide with a sibling. */
    private final String ns = "caplow-cas-" + UUID.randomUUID().toString().substring(0, 8) + "-";

    private WaitlistOfferCascadeService service() {
        return new WaitlistOfferCascadeService(
                events, attendance, scan, notifier, bookingCutoff, writer, new TransactionTemplate(txManager), clock);
    }

    @BeforeEach
    void resetSender() {
        sender.reset();
        // Millisecond clock so every offer stamp round-trips losslessly through Postgres TIMESTAMPTZ
        // (the TM-419 determinism rule from the sibling suite).
        clock.setTo(Instant.now().truncatedTo(ChronoUnit.MILLIS));
    }

    @AfterEach
    void leaveNoResidue() {
        // Foreign-safe cleanup: remove ONLY this test's namespaced rows, child-first (TM-419).
        jdbc.update(
                "DELETE FROM event_attendance WHERE user_id IN (SELECT id FROM users WHERE firebase_uid LIKE ?)",
                ns + "%");
        jdbc.update(
                "DELETE FROM events WHERE created_by IN (SELECT id FROM users WHERE firebase_uid LIKE ?)", ns + "%");
        jdbc.update("DELETE FROM users WHERE firebase_uid LIKE ?", ns + "%");
    }

    @Test
    void cascadeVoidsStaleOffersWhenCapacityLoweredBelowGoing() {
        // A capacity-2 event filled to 2 GOING, with a waitlisted member holding a LIVE offer — the
        // mid-cascade state where a spot had briefly freed and the queued member was stamped an offer.
        Event event = seedEvent(2);
        VerifiedUser g1 = newCaller("g1");
        VerifiedUser g2 = newCaller("g2");
        VerifiedUser queued = newCaller("queued");
        rsvps.rsvp(g1, event.getId());
        rsvps.rsvp(g2, event.getId()); // capacity full at 2 GOING
        rsvps.rsvp(queued, event.getId()); // lands WAITLISTED behind them
        stampOffer(event, queued); // TM-397's cascade offered them the spot
        assertThat(offerStampSet(event.getId())).containsExactly(idOf(queued));

        // The admin lowers capacity from 2 to 1 — now BELOW the GOING count of 2 (freeSpots = 1-2 = -1).
        // The edit succeeds and the two committed GOING members are never bumped.
        VerifiedUser adminCaller = newCaller("admin");
        Event edited = admin.update(adminCaller, event.getId(), capacityPatch(1));
        assertThat(edited.getCapacity()).isEqualTo(1);
        assertThat(going(event)).as("committed attendees are not bumped by the shrink").isEqualTo(2);

        // A sweep now sees no free spot on the shrunk event and voids its stale live offer — the
        // defensive cascade-stop, so the waitlisted member no longer reads "spot available to claim".
        service().sweepOpenOffers();
        assertThat(offerStampSet(event.getId()))
                .as("the stale offer on the below-capacity event is voided by the sweep")
                .isEmpty();
        // The waitlisted member is still queued (never promoted, never bumped) — just no live offer.
        assertThat(stateOf(event, queued)).isEqualTo(AttendanceState.WAITLISTED);
        // No offer push was emitted for this event — the sweep voided, it did not widen.
        assertThat(offerTokensFor(event.getId())).isEmpty();
    }

    // ------------------------------------------------------------------ fixtures

    private static final String OFFER_TITLE_PREFIX = "A spot opened:";

    /** A capacity-only patch (every other field null = unchanged), so update touches only capacity. */
    private static EventPatch capacityPatch(int capacity) {
        return new EventPatch(
                null, null, null, null, null, null, null, null, null, null, null, null, capacity, null, null, null,
                null, null, null, null, null, null);
    }

    /** A PUBLISHED, visible-now event starting in two hours with the given capacity. */
    private Event seedEvent(Integer capacity) {
        Instant now = Instant.now();
        User creator = users.saveAndFlush(new User(ns + "creator-" + UUID.randomUUID(), "creator@example.com", null));
        Event event = new Event(
                "Capacity-lower cascade " + UUID.randomUUID(),
                "Cascade capacity-shrink fixture",
                "Marhaba Cafe",
                "Europe/London",
                now.plus(Duration.ofHours(2)),
                now.minus(Duration.ofDays(1)),
                now.plus(Duration.ofDays(7)),
                creator.getId(),
                now);
        event.setCapacity(capacity);
        return events.saveAndFlush(event);
    }

    private VerifiedUser newCaller(String tag) {
        String uid = ns + tag + "-" + UUID.randomUUID();
        User user = users.saveAndFlush(new User(uid, uid + "@example.com", tag));
        return new VerifiedUser(user.getFirebaseUid(), user.getEmail());
    }

    private Long idOf(VerifiedUser caller) {
        return users.findByFirebaseUid(caller.uid()).orElseThrow().getId();
    }

    private long going(Event event) {
        return attendance.countByEventIdAndState(event.getId(), AttendanceState.GOING);
    }

    private AttendanceState stateOf(Event event, VerifiedUser caller) {
        return attendance
                .findByEventIdAndUserId(event.getId(), idOf(caller))
                .orElseThrow()
                .getState();
    }

    /** Stamp a live offer directly on this member's waitlist row (simulate a prior cascade tick). */
    private void stampOffer(Event event, VerifiedUser caller) {
        EventAttendance row =
                attendance.findByEventIdAndUserId(event.getId(), idOf(caller)).orElseThrow();
        row.recordOffer(Instant.now());
        attendance.saveAndFlush(row);
    }

    /** The user ids currently holding a live offer on the event (a WAITLISTED row with a stamp). */
    private List<Long> offerStampSet(long eventId) {
        return attendance.findWaitlistFifo(eventId).stream()
                .filter(EventAttendance::hasOpenOffer)
                .map(EventAttendance::getUserId)
                .toList();
    }

    /** Device tokens that received an OFFER push for this event (empty here — we never seed tokens). */
    private List<String> offerTokensFor(long eventId) {
        String route = "#/events/" + eventId;
        return sender.deliveries().stream()
                .filter(d -> d.message().title().startsWith(OFFER_TITLE_PREFIX))
                .filter(d -> route.equals(d.message().route()))
                .map(Delivery::token)
                .toList();
    }

    // ------------------------------------------------------------------ harness

    /** Swaps the outermost delivery seam for the recording fake — everything inboard stays real. */
    @TestConfiguration
    static class RecordingSenderConfig {
        @Bean
        @Primary
        RecordingPushSender recordingPushSender() {
            return new RecordingPushSender();
        }
    }

    /** One recorded send. */
    record Delivery(String token, PushMessage message) {}

    /** A no-FCM {@link PushSender} that records every (token, message) and reports DELIVERED. */
    static final class RecordingPushSender implements PushSender {
        private final List<Delivery> deliveries = new ArrayList<>();

        @Override
        public synchronized PushDelivery send(String token, PushMessage message) {
            deliveries.add(new Delivery(token, message));
            return PushDelivery.DELIVERED;
        }

        synchronized List<Delivery> deliveries() {
            return List.copyOf(deliveries);
        }

        synchronized void reset() {
            deliveries.clear();
        }
    }

    /** The house advanceable test clock (same shape as {@code WaitlistOfferCascadeIntegrationTest}'s). */
    private static final class MutableClock extends Clock {
        private volatile Instant now;

        MutableClock(Instant start) {
            this.now = start;
        }

        void setTo(Instant instant) {
            this.now = instant;
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
