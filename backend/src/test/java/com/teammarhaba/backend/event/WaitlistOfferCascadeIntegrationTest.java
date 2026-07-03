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
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
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
 *
 * <p><b>Isolation (TM-419).</b> The suite shares one non-transactional Testcontainers Postgres and
 * {@link WaitlistOfferCascadeService#sweepOpenOffers()} scans the <em>whole</em> DB
 * ({@link OfferCascadeScanRepository#findEventIdsWithWaitlist}), so a sibling suite's committed rows
 * are visible to the sweep. Rather than wipe the shared DB in {@code @BeforeEach} (antisocial to
 * other suites, and the approach that only masked an ordering-dependent
 * {@code uq_event_attendance_event_user} flake), each test is made robust to foreign rows: every
 * firebase_uid and device token is namespaced to the test method ({@link #ns}) so a find-or-create
 * {@code seedUser} can never collide with another suite, and every assertion is scoped to the test's
 * <em>own</em> event ({@link #offerTokens(long)}, {@link #offerStampSet(long)},
 * {@link #sweepForEvent(long)}). Cleanup deletes only this test's namespaced rows. The cascade
 * itself only ever <em>updates</em> attendance ({@code recordOffer} then {@code save} of a row it
 * loaded in the same transaction — a merge, never an insert), so it cannot double-insert.
 *
 * <p><b>Deterministic widen boundary (TM-419).</b> The other, primary half of the flake was timing,
 * not a product bug either: {@code offer_notified_at} is a Postgres {@code TIMESTAMPTZ} (microsecond
 * precision, and PG <em>rounds</em> on store), so a nanosecond-precision {@code Instant.now()} (the
 * Linux/CI clock; macOS is only micros, which is why it passed locally) could round the persisted
 * offer stamp <em>up</em> a few ns. An assertion made <em>exactly</em> on a five-minute widen
 * boundary then integer-divides {@code (now − episodeStart)} to {@code elapsed = 0} and the widen
 * never fires — a ~50/50 coin-flip, so a different method failed each CI run. {@link #cleanSlate()}
 * truncates the driving clock to milliseconds so every stamp round-trips losslessly and the boundary
 * maths are exact on every platform.
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
    @Autowired private BookingCutoffPolicy bookingCutoff;
    @Autowired private PlatformTransactionManager txManager;
    @Autowired private RecordingPushSender sender;

    private final MutableClock clock = new MutableClock(Instant.now());

    /**
     * A per-test-method namespace prefixed onto every firebase_uid and device token this test seeds,
     * so its find-or-create fixtures can never collide with a sibling suite's rows on the shared
     * Testcontainers DB (TM-419). JUnit's per-method instance lifecycle gives a fresh value each test,
     * which also isolates this class's own methods from one another.
     */
    private final String ns = "cas-" + UUID.randomUUID().toString().substring(0, 8) + "-";

    private WaitlistOfferCascadeService service() {
        return new WaitlistOfferCascadeService(
                events, attendance, scan, notifier, bookingCutoff, new TransactionTemplate(txManager), clock);
    }

    @BeforeEach
    void cleanSlate() {
        sender.reset();
        // Truncate to millis so every offer stamp round-trips losslessly (TM-419). offer_notified_at is
        // a Postgres TIMESTAMPTZ (microsecond precision, and PG *rounds* on store); a nanosecond-precision
        // Instant.now() (Linux/CI clock — macOS is only micros) can round UP, pushing the persisted
        // episodeStart a few ns past t0 so an assertion made exactly on the 5-minute widen boundary
        // integer-divides to elapsed=0 and the widen never fires. Millisecond time is stored exactly, so
        // the boundary maths become deterministic on every platform.
        clock.setTo(Instant.now().truncatedTo(ChronoUnit.MILLIS));
    }

    @AfterEach
    void leaveNoResidue() {
        // Good-citizen, foreign-safe cleanup (TM-419): remove ONLY the rows this test created — keyed
        // by the per-test firebase_uid namespace — never a DB-wide wipe (which nuked sibling suites'
        // rows and merely masked the flake). Child-first delete order so no FK constraint bites.
        jdbc.update(
                "DELETE FROM event_attendance WHERE user_id IN (SELECT id FROM users WHERE firebase_uid LIKE ?)",
                ns + "%");
        jdbc.update(
                "DELETE FROM device_tokens WHERE user_id IN (SELECT id FROM users WHERE firebase_uid LIKE ?)",
                ns + "%");
        jdbc.update(
                "DELETE FROM events WHERE created_by IN (SELECT id FROM users WHERE firebase_uid LIKE ?)", ns + "%");
        jdbc.update("DELETE FROM users WHERE firebase_uid LIKE ?", ns + "%");
    }

    // ------------------------------------------------------------------ tests

    @Test
    void offersTheFifoHeadAtT0ThenWidensOneMemberEveryFiveMinutes() {
        long eventId = seedEvent("Iftar Meetup", 1).getId();
        long w1 = seedWaitlisted(eventId, "w1", NotificationPref.PUSH);
        long w2 = seedWaitlisted(eventId, "w2", NotificationPref.PUSH);
        long w3 = seedWaitlisted(eventId, "w3", NotificationPref.PUSH);
        Instant t0 = clock.instant();

        // T+0: only the FIFO head is offered.
        assertThat(sweepForEvent(eventId)).isEqualTo(1);
        assertThat(offerTokens(eventId)).containsExactly(tok("w1"));
        assertThat(offerStampSet(eventId)).containsExactly(w1);

        // Before five minutes elapse the pool does not widen (the spacing).
        clock.setTo(t0.plus(Duration.ofMinutes(4)));
        assertThat(sweepForEvent(eventId)).isZero();
        assertThat(offerTokens(eventId)).containsExactly(tok("w1"));

        // At +5m the next FIFO member is added; at +10m the third.
        clock.setTo(t0.plus(Duration.ofMinutes(5)));
        assertThat(sweepForEvent(eventId)).isEqualTo(1);
        assertThat(offerTokens(eventId)).containsExactly(tok("w1"), tok("w2"));
        assertThat(offerStampSet(eventId)).containsExactlyInAnyOrder(w1, w2);

        clock.setTo(t0.plus(Duration.ofMinutes(10)));
        assertThat(sweepForEvent(eventId)).isEqualTo(1);
        assertThat(offerTokens(eventId)).containsExactly(tok("w1"), tok("w2"), tok("w3"));

        // The waitlist is now exhausted — later sweeps widen no further and never re-offer.
        clock.setTo(t0.plus(Duration.ofMinutes(20)));
        assertThat(sweepForEvent(eventId)).isZero();
        assertThat(offerTokens(eventId)).containsExactly(tok("w1"), tok("w2"), tok("w3"));
        assertThat(offerStampSet(eventId)).containsExactlyInAnyOrder(w1, w2, w3);
    }

    @Test
    void stopsTheInstantTheSpotIsClaimed() {
        long eventId = seedEvent("Jummah Lunch", 1).getId();
        long w1 = seedWaitlisted(eventId, "stop-w1", NotificationPref.PUSH);
        long w2 = seedWaitlisted(eventId, "stop-w2", NotificationPref.PUSH);
        Instant t0 = clock.instant();

        assertThat(sweepForEvent(eventId)).isEqualTo(1);
        assertThat(offerTokens(eventId)).containsExactly(tok("stop-w1")); // w1 offered

        // w2 (not the FIFO head) claims the single spot — first-claim-wins fills capacity and the
        // claim voids w1's live offer (the cascade-stop signal from EventRsvpService.claim).
        rsvps.claim(caller(w2), eventId);
        assertThat(offerStampSet(eventId)).isEmpty(); // w1's offer voided on the last-spot fill

        // A later sweep sees no free spot and offers nobody — the cascade is over, w1 never re-offered.
        clock.setTo(t0.plus(Duration.ofMinutes(10)));
        assertThat(sweepForEvent(eventId)).isZero();
        assertThat(offerTokens(eventId)).containsExactly(tok("stop-w1"));
        assertThat(attendance.countByEventIdAndState(eventId, AttendanceState.GOING)).isEqualTo(1);
        // w1 is still queued (never promoted — the owner policy), just no longer holding an offer.
        assertThat(attendance.findByEventIdAndUserId(eventId, w1).orElseThrow().getState())
                .isEqualTo(AttendanceState.WAITLISTED);
    }

    @Test
    void repeatedAndRestartedSweepsNeverReoffer() {
        long eventId = seedEvent("Eid Picnic", 1).getId();
        seedWaitlisted(eventId, "idem-w1", NotificationPref.PUSH);
        seedWaitlisted(eventId, "idem-w2", NotificationPref.PUSH);

        assertThat(sweepForEvent(eventId)).isEqualTo(1);
        assertThat(offerTokens(eventId)).containsExactly(tok("idem-w1"));

        // Same instance sweeps again immediately: nothing new (spacing not elapsed, w1 already offered).
        assertThat(sweepForEvent(eventId)).isZero();

        // A brand-new service instance ("after a restart" / another Cloud Run instance): the stamp
        // lives in Postgres, not in process memory, so it continues rather than re-offers.
        assertThat(sweepForEvent(eventId)).isZero();
        assertThat(offerTokens(eventId)).containsExactly(tok("idem-w1"));
    }

    @Test
    void multipleFreeSpotsOfferThePoolAtOnceThenWiden() {
        // Two free spots on a capacity-2 event with three waiting: T+0 offers the first TWO members
        // (the pool == free spots), then widening adds the third at +5m.
        long eventId = seedEvent("Community Dinner", 2).getId();
        long w1 = seedWaitlisted(eventId, "multi-w1", NotificationPref.PUSH);
        long w2 = seedWaitlisted(eventId, "multi-w2", NotificationPref.PUSH);
        long w3 = seedWaitlisted(eventId, "multi-w3", NotificationPref.PUSH);
        Instant t0 = clock.instant();

        assertThat(sweepForEvent(eventId)).isEqualTo(2);
        assertThat(offerTokens(eventId)).containsExactly(tok("multi-w1"), tok("multi-w2"));
        assertThat(offerStampSet(eventId)).containsExactlyInAnyOrder(w1, w2);

        clock.setTo(t0.plus(Duration.ofMinutes(5)));
        assertThat(sweepForEvent(eventId)).isEqualTo(1);
        assertThat(offerTokens(eventId)).containsExactly(tok("multi-w1"), tok("multi-w2"), tok("multi-w3"));
        assertThat(offerStampSet(eventId)).containsExactlyInAnyOrder(w1, w2, w3);
    }

    @Test
    void offerHonoursNotificationPrefButStillStampsTheInAppOffer() {
        // An EMAIL-pref (push opted-out) member at the FIFO head is still OFFERED (the in-app stamp is
        // set so they can claim) but receives no push — the pref gates delivery, not the offer.
        long eventId = seedEvent("Study Circle", 1).getId();
        long optedOut = seedWaitlisted(eventId, "pref-w1", NotificationPref.EMAIL);

        assertThat(sweepForEvent(eventId)).isEqualTo(1);
        assertThat(offerStampSet(eventId)).containsExactly(optedOut); // offered (stamped) ...
        assertThat(offerTokens(eventId)).isEmpty(); // ... but not pushed (EMAIL is the opt-out)
    }

    @Test
    void aSpotThatVanishesWithoutAClaimVoidsAnyStaleOffer() {
        // Defensive cascade-stop: capacity full (no free spot) yet a live offer lingers — the sweep
        // voids it rather than leaving a stale "spot available" the member could never claim.
        long eventId = seedEvent("Full House", 1).getId();
        long going = seedUser("def-going", NotificationPref.PUSH);
        attendance.saveAndFlush(new EventAttendance(eventId, going, AttendanceState.GOING)); // fills capacity
        long w1 = seedWaitlisted(eventId, "def-w1", NotificationPref.PUSH);
        stampOffer(eventId, w1); // a stale live offer with no matching free spot

        assertThat(sweepForEvent(eventId)).isZero();
        assertThat(offerStampSet(eventId)).isEmpty(); // the stale offer was voided
        assertThat(offerTokens(eventId)).isEmpty();
    }

    @Test
    void neverOffersOnAStartedEvent() {
        // Attendance freezes once an event starts (claim is refused), so the cascade offers nobody.
        long eventId = seedEvent("Already Begun", 1).getId();
        seedWaitlisted(eventId, "started-w1", NotificationPref.PUSH);
        clock.setTo(events.findById(eventId).orElseThrow().getStartAt().plus(Duration.ofMinutes(1)));

        assertThat(sweepForEvent(eventId)).isZero();
        assertThat(offerTokens(eventId)).isEmpty();
        assertThat(offerStampSet(eventId)).isEmpty();
    }

    @Test
    void neverOffersInsideTheBookingCutoffWindow() {
        // TM-424: a spot freed in the final hour before start must NOT be offered — past the booking
        // cutoff a claim 409s BOOKING_CLOSED, so nudging the waitlist toward a spot they cannot take
        // is the bug. The cascade now applies the exact gate claim does (visible + not started +
        // before cutoff), so it offers nobody here even though the event is still visible and unstarted.
        Event event = seedEvent("Last Hour", 1);
        long eventId = event.getId();
        seedWaitlisted(eventId, "cutoff-w1", NotificationPref.PUSH);

        // Default cutoff is 1h and the event starts 2h out; step to 30m before start — inside the
        // cutoff window, yet still visible and not yet started, so ONLY the new cutoff gate can stop it.
        Instant insideCutoff = event.getStartAt().minus(Duration.ofMinutes(30));
        assertThat(bookingCutoff.isPastCutoff(event, insideCutoff)).isTrue();
        clock.setTo(insideCutoff);

        assertThat(sweepForEvent(eventId)).isZero();
        assertThat(offerStampSet(eventId)).isEmpty();
        assertThat(offerTokens(eventId)).isEmpty();
    }

    @Test
    void offerMessageCarriesHeadingAndAllowListedEventDetailRoute() {
        long eventId = seedEvent("Marhaba Mixer", 1).getId();
        seedWaitlisted(eventId, "msg-w1", NotificationPref.PUSH);

        service().sweepOpenOffers();

        PushMessage message = sender.deliveries().stream()
                .filter(d -> ("#/events/" + eventId).equals(d.message().route()))
                .map(Delivery::message)
                .findFirst()
                .orElseThrow();
        assertThat(message.title()).isEqualTo("A spot opened: Marhaba Mixer");
        assertThat(message.body()).contains("First to claim");
        assertThat(message.route()).isEqualTo("#/events/" + eventId);
    }

    // ------------------------------------------------------------------ fixtures

    /** This test method's unique firebase_uid for a member {@code label} (see {@link #ns}). */
    private String uid(String label) {
        return ns + label;
    }

    /** This test method's unique device token for a member {@code label} (globally UNIQUE column). */
    private String tok(String label) {
        return ns + "tok-" + label;
    }

    private long seedUser(String label, NotificationPref pref) {
        String uid = uid(label);
        User u = users.findByFirebaseUid(uid)
                .orElseGet(() -> users.saveAndFlush(new User(uid, uid + "@example.com", null)));
        u.setNotificationPref(pref);
        return users.saveAndFlush(u).getId();
    }

    private void seedToken(long userId, String label) {
        deviceTokens.saveAndFlush(new DeviceToken(userId, tok(label), DevicePlatform.ANDROID, Instant.now()));
    }

    /** A PUBLISHED, visible-now event starting in two hours, with the given GOING capacity. */
    private Event seedEvent(String heading, Integer capacity) {
        Instant now = Instant.now();
        long creator = seedUser("creator", NotificationPref.EMAIL);
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
    private long seedWaitlisted(long eventId, String label, NotificationPref pref) {
        long userId = seedUser(label, pref);
        seedToken(userId, label);
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

    /** The device tokens that received an OFFER push <em>for this event</em>, in delivery order. */
    private List<String> offerTokens(long eventId) {
        String route = "#/events/" + eventId;
        return sender.deliveries().stream()
                .filter(d -> d.message().title().startsWith(OFFER_TITLE_PREFIX))
                .filter(d -> route.equals(d.message().route()))
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

    /**
     * Run one production-shape DB-wide sweep, but report only how many members were <em>newly</em>
     * offered on THIS test's own event (TM-419). Scoping to the test's event makes the count immune to
     * any foreign event the DB-wide scan picks up on the shared DB; using the set difference (rather
     * than a size delta) keeps it at {@code 0} — never negative — when a defensive sweep voids a stale
     * offer. It matches {@link WaitlistOfferCascadeService#sweepOpenOffers()}'s own semantics: both
     * count members freshly stamped this sweep.
     */
    private int sweepForEvent(long eventId) {
        Set<Long> before = Set.copyOf(offerStampSet(eventId));
        service().sweepOpenOffers();
        return (int) offerStampSet(eventId).stream().filter(id -> !before.contains(id)).count();
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
