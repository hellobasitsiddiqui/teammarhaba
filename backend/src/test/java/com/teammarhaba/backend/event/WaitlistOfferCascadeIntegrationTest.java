package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.notify.PushDelivery;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushSender;
import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
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
 * The waitlist offer cascade (TM-397) end-to-end against real Postgres: a freed spot offered to the
 * FIFO waitlist, widening one member every five minutes, stopping the instant it is claimed, and
 * doing so idempotently across repeat sweeps and a "restarted" service instance — the persisted
 * {@code offer_notified_at} stamp is the whole state, so a second instance continues rather than
 * restarts the cascade.
 *
 * <p>The service under test is built directly with a mutable {@link Clock} (the house test seam, as
 * {@code EventReminderIntegrationTest}) so "five minutes pass" is explicit and deterministic; the
 * background sweep is off in the test profile ({@code app.offer-cascade.enabled: false}) so no live
 * tick races these assertions. Never {@code @Transactional}: each sweep commits like production,
 * which is what makes the stamp semantics real. The outermost {@link PushSender} is a recording fake
 * (no FCM); everything inboard — the per-event {@code FOR UPDATE} lock, the fan-out rails — stays
 * real.
 */
@Import(WaitlistOfferCascadeIntegrationTest.RecordingSenderConfig.class)
class WaitlistOfferCascadeIntegrationTest extends AbstractIntegrationTest {

    private static final String OFFER_TITLE_PREFIX = "A spot opened:";

    @Autowired private EventRepository events;
    @Autowired private EventAttendanceRepository attendance;
    @Autowired private OfferCascadeScanRepository scan;
    @Autowired private EventAttendeeNotifier notifier;
    @Autowired private UserRepository users;
    @Autowired private DeviceTokenRepository deviceTokens;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private EventRsvpService rsvps;
    @Autowired private PlatformTransactionManager txManager;
    @Autowired private RecordingPushSender sender;

    private final MutableClock clock = new MutableClock(Instant.now());

    private WaitlistOfferCascadeService service() {
        return new WaitlistOfferCascadeService(
                events, attendance, scan, notifier, new TransactionTemplate(txManager), clock);
    }

    @BeforeEach
    void cleanSlate() {
        wipe();
        sender.reset();
        clock.setTo(Instant.now());
    }

    @AfterEach
    void leaveNoResidue() {
        wipe(); // good-citizen cleanup: the suite shares one DB, and the scan is DB-wide
    }

    /**
     * A full FK-safe truncation of the tables this DB-wide cascade scan can see (TM-419). Wiping only
     * attendance left {@code events} and {@code users} behind, and {@link #seedUser} is find-or-create
     * by firebase_uid — so leaked users/events from other tests (or this class's own earlier methods)
     * polluted the shared Postgres and made the sweep collide on {@code uq_event_attendance_event_user}
     * depending on surefire ordering (a different method failed on each run). Raw SQL so the {@code users}
     * soft-delete {@code @SQLRestriction} can't hide a stale row; child-first delete order.
     */
    private void wipe() {
        jdbc.update("DELETE FROM event_attendance");
        deviceTokens.deleteAll();
        jdbc.update("DELETE FROM events");
        jdbc.update("DELETE FROM users");
    }

    // ------------------------------------------------------------------ tests

    @Test
    void offersTheFifoHeadAtT0ThenWidensOneMemberEveryFiveMinutes() {
        long eventId = seedEvent("Iftar Meetup", 1).getId();
        long w1 = seedWaitlisted(eventId, "cas-w1", NotificationPref.PUSH, "tok-w1");
        long w2 = seedWaitlisted(eventId, "cas-w2", NotificationPref.PUSH, "tok-w2");
        long w3 = seedWaitlisted(eventId, "cas-w3", NotificationPref.PUSH, "tok-w3");
        Instant t0 = clock.instant();

        // T+0: only the FIFO head is offered.
        assertThat(service().sweepOpenOffers()).isEqualTo(1);
        assertThat(offerTokens()).containsExactly("tok-w1");
        assertThat(offerStampSet(eventId)).containsExactly(w1);

        // Before five minutes elapse the pool does not widen (the spacing).
        clock.setTo(t0.plus(Duration.ofMinutes(4)));
        assertThat(service().sweepOpenOffers()).isZero();
        assertThat(offerTokens()).containsExactly("tok-w1");

        // At +5m the next FIFO member is added; at +10m the third.
        clock.setTo(t0.plus(Duration.ofMinutes(5)));
        assertThat(service().sweepOpenOffers()).isEqualTo(1);
        assertThat(offerTokens()).containsExactly("tok-w1", "tok-w2");
        assertThat(offerStampSet(eventId)).containsExactlyInAnyOrder(w1, w2);

        clock.setTo(t0.plus(Duration.ofMinutes(10)));
        assertThat(service().sweepOpenOffers()).isEqualTo(1);
        assertThat(offerTokens()).containsExactly("tok-w1", "tok-w2", "tok-w3");

        // The waitlist is now exhausted — later sweeps widen no further and never re-offer.
        clock.setTo(t0.plus(Duration.ofMinutes(20)));
        assertThat(service().sweepOpenOffers()).isZero();
        assertThat(offerTokens()).containsExactly("tok-w1", "tok-w2", "tok-w3");
        assertThat(offerStampSet(eventId)).containsExactlyInAnyOrder(w1, w2, w3);
    }

    @Test
    void stopsTheInstantTheSpotIsClaimed() {
        long eventId = seedEvent("Jummah Lunch", 1).getId();
        long w1 = seedWaitlisted(eventId, "cas-stop-w1", NotificationPref.PUSH, "tok-stop-w1");
        long w2 = seedWaitlisted(eventId, "cas-stop-w2", NotificationPref.PUSH, "tok-stop-w2");
        Instant t0 = clock.instant();

        assertThat(service().sweepOpenOffers()).isEqualTo(1);
        assertThat(offerTokens()).containsExactly("tok-stop-w1"); // w1 offered

        // w2 (not the FIFO head) claims the single spot — first-claim-wins fills capacity and the
        // claim voids w1's live offer (the cascade-stop signal from EventRsvpService.claim).
        rsvps.claim(caller(w2), eventId);
        assertThat(offerStampSet(eventId)).isEmpty(); // w1's offer voided on the last-spot fill

        // A later sweep sees no free spot and offers nobody — the cascade is over, w1 never re-offered.
        clock.setTo(t0.plus(Duration.ofMinutes(10)));
        assertThat(service().sweepOpenOffers()).isZero();
        assertThat(offerTokens()).containsExactly("tok-stop-w1");
        assertThat(attendance.countByEventIdAndState(eventId, AttendanceState.GOING)).isEqualTo(1);
        // w1 is still queued (never promoted — the owner policy), just no longer holding an offer.
        assertThat(attendance.findByEventIdAndUserId(eventId, w1).orElseThrow().getState())
                .isEqualTo(AttendanceState.WAITLISTED);
    }

    @Test
    void repeatedAndRestartedSweepsNeverReoffer() {
        long eventId = seedEvent("Eid Picnic", 1).getId();
        seedWaitlisted(eventId, "cas-idem-w1", NotificationPref.PUSH, "tok-idem-w1");
        seedWaitlisted(eventId, "cas-idem-w2", NotificationPref.PUSH, "tok-idem-w2");

        assertThat(service().sweepOpenOffers()).isEqualTo(1);
        assertThat(offerTokens()).containsExactly("tok-idem-w1");

        // Same instance sweeps again immediately: nothing new (spacing not elapsed, w1 already offered).
        assertThat(service().sweepOpenOffers()).isZero();

        // A brand-new service instance ("after a restart" / another Cloud Run instance): the stamp
        // lives in Postgres, not in process memory, so it continues rather than re-offers.
        assertThat(service().sweepOpenOffers()).isZero();
        assertThat(offerTokens()).containsExactly("tok-idem-w1");
    }

    @Test
    void multipleFreeSpotsOfferThePoolAtOnceThenWiden() {
        // Two free spots on a capacity-2 event with three waiting: T+0 offers the first TWO members
        // (the pool == free spots), then widening adds the third at +5m.
        long eventId = seedEvent("Community Dinner", 2).getId();
        long w1 = seedWaitlisted(eventId, "cas-multi-w1", NotificationPref.PUSH, "tok-multi-w1");
        long w2 = seedWaitlisted(eventId, "cas-multi-w2", NotificationPref.PUSH, "tok-multi-w2");
        long w3 = seedWaitlisted(eventId, "cas-multi-w3", NotificationPref.PUSH, "tok-multi-w3");
        Instant t0 = clock.instant();

        assertThat(service().sweepOpenOffers()).isEqualTo(2);
        assertThat(offerTokens()).containsExactly("tok-multi-w1", "tok-multi-w2");
        assertThat(offerStampSet(eventId)).containsExactlyInAnyOrder(w1, w2);

        clock.setTo(t0.plus(Duration.ofMinutes(5)));
        assertThat(service().sweepOpenOffers()).isEqualTo(1);
        assertThat(offerTokens()).containsExactly("tok-multi-w1", "tok-multi-w2", "tok-multi-w3");
        assertThat(offerStampSet(eventId)).containsExactlyInAnyOrder(w1, w2, w3);
    }

    @Test
    void offerHonoursNotificationPrefButStillStampsTheInAppOffer() {
        // An EMAIL-pref (push opted-out) member at the FIFO head is still OFFERED (the in-app stamp is
        // set so they can claim) but receives no push — the pref gates delivery, not the offer.
        long eventId = seedEvent("Study Circle", 1).getId();
        long optedOut = seedWaitlisted(eventId, "cas-pref-w1", NotificationPref.EMAIL, "tok-pref-w1");

        assertThat(service().sweepOpenOffers()).isEqualTo(1);
        assertThat(offerStampSet(eventId)).containsExactly(optedOut); // offered (stamped) ...
        assertThat(offerTokens()).isEmpty(); // ... but not pushed (EMAIL is the opt-out)
    }

    @Test
    void aSpotThatVanishesWithoutAClaimVoidsAnyStaleOffer() {
        // Defensive cascade-stop: capacity full (no free spot) yet a live offer lingers — the sweep
        // voids it rather than leaving a stale "spot available" the member could never claim.
        long eventId = seedEvent("Full House", 1).getId();
        long going = seedUser("cas-def-going", NotificationPref.PUSH);
        attendance.saveAndFlush(new EventAttendance(eventId, going, AttendanceState.GOING)); // fills capacity
        long w1 = seedWaitlisted(eventId, "cas-def-w1", NotificationPref.PUSH, "tok-def-w1");
        stampOffer(eventId, w1); // a stale live offer with no matching free spot

        assertThat(service().sweepOpenOffers()).isZero();
        assertThat(offerStampSet(eventId)).isEmpty(); // the stale offer was voided
        assertThat(offerTokens()).isEmpty();
    }

    @Test
    void neverOffersOnAStartedEvent() {
        // Attendance freezes once an event starts (claim is refused), so the cascade offers nobody.
        long eventId = seedEvent("Already Begun", 1).getId();
        seedWaitlisted(eventId, "cas-started-w1", NotificationPref.PUSH, "tok-started-w1");
        clock.setTo(events.findById(eventId).orElseThrow().getStartAt().plus(Duration.ofMinutes(1)));

        assertThat(service().sweepOpenOffers()).isZero();
        assertThat(offerTokens()).isEmpty();
        assertThat(offerStampSet(eventId)).isEmpty();
    }

    @Test
    void offerMessageCarriesHeadingAndAllowListedEventDetailRoute() {
        long eventId = seedEvent("Marhaba Mixer", 1).getId();
        seedWaitlisted(eventId, "cas-msg-w1", NotificationPref.PUSH, "tok-msg-w1");

        service().sweepOpenOffers();

        PushMessage message = sender.deliveries().get(0).message();
        assertThat(message.title()).isEqualTo("A spot opened: Marhaba Mixer");
        assertThat(message.body()).contains("First to claim");
        assertThat(message.route()).isEqualTo("#/events/" + eventId);
    }

    // ------------------------------------------------------------------ fixtures

    private long seedUser(String uid, NotificationPref pref) {
        User u = users.findByFirebaseUid(uid)
                .orElseGet(() -> users.saveAndFlush(new User(uid, uid + "@example.com", null)));
        u.setNotificationPref(pref);
        return users.saveAndFlush(u).getId();
    }

    private void seedToken(long userId, String token) {
        deviceTokens.saveAndFlush(new DeviceToken(userId, token, DevicePlatform.ANDROID, Instant.now()));
    }

    /** A PUBLISHED, visible-now event starting in two hours, with the given GOING capacity. */
    private Event seedEvent(String heading, Integer capacity) {
        Instant now = Instant.now();
        long creator = seedUser("cascade-creator", NotificationPref.EMAIL);
        Event event = new Event(
                heading,
                "Offer cascade test event",
                "Marhaba Cafe, 12 High St",
                "Europe/London",
                now.plus(Duration.ofHours(2)),
                now.minus(Duration.ofDays(1)),
                now.plus(Duration.ofDays(7)),
                creator,
                now);
        event.setCapacity(capacity);
        return events.saveAndFlush(event);
    }

    /** Seed one waitlisted member (FIFO order == call order) with a device token, and return their id. */
    private long seedWaitlisted(long eventId, String uid, NotificationPref pref, String token) {
        long userId = seedUser(uid, pref);
        seedToken(userId, token);
        attendance.saveAndFlush(new EventAttendance(eventId, userId, AttendanceState.WAITLISTED));
        return userId;
    }

    /** Stamp a live offer directly (simulate a stale/prior-episode offer for the defensive case). */
    private void stampOffer(long eventId, long userId) {
        EventAttendance row = attendance.findByEventIdAndUserId(eventId, userId).orElseThrow();
        row.recordOffer(Instant.now());
        attendance.saveAndFlush(row);
    }

    private VerifiedUser caller(long userId) {
        User u = users.findById(userId).orElseThrow();
        return new VerifiedUser(u.getFirebaseUid(), u.getEmail());
    }

    /** The device tokens that received an OFFER push, in delivery order (confirmations excluded). */
    private List<String> offerTokens() {
        return sender.deliveries().stream()
                .filter(d -> d.message().title().startsWith(OFFER_TITLE_PREFIX))
                .map(Delivery::token)
                .toList();
    }

    /** The user ids currently holding a live offer on the event (a WAITLISTED row with a stamp). */
    private List<Long> offerStampSet(long eventId) {
        return attendance.findWaitlistFifo(eventId).stream()
                .filter(EventAttendance::hasOpenOffer)
                .map(EventAttendance::getUserId)
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

    /** The house advanceable test clock (same shape as {@code EventReminderIntegrationTest}'s). */
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
