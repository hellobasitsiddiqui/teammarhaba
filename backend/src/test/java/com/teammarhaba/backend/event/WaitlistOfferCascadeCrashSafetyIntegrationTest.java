package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.notify.Notification;
import com.teammarhaba.backend.notify.NotificationRepository;
import com.teammarhaba.backend.notify.NotificationType;
import com.teammarhaba.backend.notify.NotificationWriter;
import com.teammarhaba.backend.notify.PushDelivery;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
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
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
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
 * Characterization of the offer cascade's documented crash-safety invariant
 * (P2 {@code cascadeStampCommitPush_crashBetweenCommitAndPush}, part of TM-738 / TM-762).
 *
 * <p>{@link WaitlistOfferCascadeService}'s javadoc pins the ordering <em>stamp → commit → push</em>
 * and states: "a crash between the two drops that one offer push (the member still sees the in-app
 * 'spot available to claim' from the committed stamp) rather than ever double-pushing." That claim is
 * the whole reason the stamp is committed <b>before</b> the push fan-out — but the primary suite
 * ({@code WaitlistOfferCascadeIntegrationTest}) only exercises the happy commit-then-push path and
 * never simulates a crash in the gap. This test pins the two halves of the invariant against real
 * Postgres so a regression that (a) rolled the stamp back on a push failure, or (b) re-pushed a
 * member who already holds a committed stamp, is caught:
 *
 * <ol>
 *   <li><b>The stamp survives a push crash.</b> With a notifier whose post-commit {@code pushToUsers}
 *       throws, one sweep propagates the failure, yet the {@code offer_notified_at} stamp is committed
 *       (the member holds a live in-app offer they can claim). The stamp is written inside
 *       {@code tx.execute(...)} which commits before the push runs, so a push exception cannot unwind
 *       it.</li>
 *   <li><b>The retry never double-pushes.</b> A subsequent normal sweep (real notifier) offers nobody
 *       new and sends no push for that member: the committed stamp is the idempotency marker, so the
 *       dropped push is dropped for good, not re-sent. That is the "rather than ever double-pushing"
 *       half — the safe failure mode is a lost push, not a duplicate one.</li>
 * </ol>
 *
 * <p>This asserts EXISTING behaviour and must pass with no source change. It mirrors the primary
 * suite's harness verbatim: never {@code @Transactional} (each sweep commits like production, which
 * is what makes the stamp semantics real), a recording fake {@link PushSender} at the outermost seam,
 * a mutable {@link Clock}, a millisecond-truncated driving clock (TM-419 boundary determinism), and
 * per-method namespaced fixtures so it is foreign-row safe on the shared Testcontainers DB.
 */
@Import(WaitlistOfferCascadeCrashSafetyIntegrationTest.RecordingSenderConfig.class)
class WaitlistOfferCascadeCrashSafetyIntegrationTest extends AbstractIntegrationTest {

    private static final String OFFER_TITLE_PREFIX = "A spot opened:";

    @Autowired private EventRepository events;
    @Autowired private EventAttendanceRepository attendance;
    @Autowired private OfferCascadeScanRepository scan;
    @Autowired private EventAttendeeNotifier notifier;
    @Autowired private UserRepository users;
    @Autowired private DeviceTokenRepository deviceTokens;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private BookingCutoffPolicy bookingCutoff;
    @Autowired private PlatformTransactionManager txManager;
    @Autowired private RecordingPushSender sender;
    @Autowired private NotificationWriter writer;
    @Autowired private NotificationRepository notifications;

    private final MutableClock clock = new MutableClock(Instant.now());

    /** Per-method firebase_uid / device-token namespace so fixtures can't collide on the shared DB. */
    private final String ns = "cra-" + UUID.randomUUID().toString().substring(0, 8) + "-";

    /** A real service wired with the real notifier (the happy retry path). */
    private WaitlistOfferCascadeService service() {
        return service(notifier);
    }

    /** A service wired with a caller-supplied notifier — the seam that injects the push crash. */
    private WaitlistOfferCascadeService service(EventAttendeeNotifier withNotifier) {
        return new WaitlistOfferCascadeService(
                events,
                attendance,
                scan,
                withNotifier,
                bookingCutoff,
                writer,
                new TransactionTemplate(txManager),
                clock);
    }

    @BeforeEach
    void cleanSlate() {
        sender.reset();
        // Truncate to millis so the offer stamp round-trips losslessly (TM-419): a TIMESTAMPTZ rounds on
        // store, so an exact-boundary nanos assertion could integer-divide to elapsed=0. This test never
        // asserts a widen boundary, but we keep the house pattern so stamps are stored exactly.
        clock.setTo(Instant.now().truncatedTo(ChronoUnit.MILLIS));
    }

    @AfterEach
    void leaveNoResidue() {
        // Foreign-safe cleanup: only this test's namespaced rows, child-first so no FK constraint bites.
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
    void stampSurvivesAPushCrashAndTheRetryNeverDoublePushes() {
        long eventId = seedEvent("Crash Test Dinner", 1).getId();
        long w1 = seedWaitlisted(eventId, "crash-w1", NotificationPref.PUSH);

        // --- Sweep 1: the push fan-out crashes AFTER the stamp has committed. -----------------------
        AtomicInteger crashingCalls = new AtomicInteger();
        // Crash ONLY on this test's own member (w1), delegating any foreign event the DB-wide scan picks up
        // on the shared Testcontainers DB to the real notifier — so an unrelated event swept first cannot
        // abort the loop before it reaches mine. The stamp for w1 is already committed by tx.execute(...)
        // before offerForEvent reaches this push call, so throwing here reproduces the commit→push gap.
        EventAttendeeNotifier crashingNotifier = new EventAttendeeNotifier(users, deviceTokens, null) {
            @Override
            public PushFanout pushToUsers(Collection<Long> userIds, PushMessage message) {
                if (userIds.contains(w1)) {
                    crashingCalls.incrementAndGet();
                    throw new IllegalStateException("simulated push crash between commit and push");
                }
                return notifier.pushToUsers(userIds, message); // foreign events proceed normally
            }
        };

        assertThatThrownBy(() -> service(crashingNotifier).sweepOpenOffers())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("simulated push crash");

        // The stamp IS committed despite the push crash — the member holds a live in-app offer they can
        // claim (the "still sees the in-app spot available to claim" half of the invariant). Note the
        // in-app signal is the committed ATTENDANCE stamp, not the durable inbox row: offerForEvent writes
        // the WAITLIST_OFFER inbox row AFTER the push, so a crash on the push skips it too — yet the member
        // can still claim off the stamp.
        assertThat(crashingCalls.get()).isEqualTo(1); // the crash happened AFTER the stamp, on the push
        assertThat(offerStampSet(eventId)).containsExactly(w1);
        // No push reached FCM (the send seam threw before any delivery was recorded) — the push is DROPPED.
        assertThat(offerTokens(eventId)).isEmpty();
        // The durable inbox row is post-push, so the crash drops it too (the stamp is the in-app signal).
        assertThat(inboxTypes(w1)).doesNotContain(NotificationType.WAITLIST_OFFER);

        // --- Sweep 2: a normal sweep (real notifier) must NOT re-push the already-stamped member. -----
        int newlyOffered = sweepForEvent(eventId);
        assertThat(newlyOffered).isZero(); // committed stamp = idempotency marker → nobody newly offered
        assertThat(offerStampSet(eventId)).containsExactly(w1); // still exactly one stamp, unchanged
        // The dropped push is dropped for good — the retry sends NO push for w1 ("rather than ever
        // double-pushing"). The safe failure mode is a lost push, never a duplicate one.
        assertThat(offerTokens(eventId)).isEmpty();
    }

    // ------------------------------------------------------------------ fixtures

    /** The notification types in a user's durable inbox, newest-first (TM-453). */
    private List<NotificationType> inboxTypes(long userId) {
        return notifications.findByUserIdOrderByCreatedAtDescIdDesc(userId).stream()
                .map(Notification::getType)
                .toList();
    }

    private String uid(String label) {
        return ns + label;
    }

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
                "Offer cascade crash-safety test event",
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
     * Run one production-shape DB-wide sweep, reporting only members <em>newly</em> stamped on THIS
     * test's own event — foreign events on the shared DB never move the count (mirrors the primary
     * suite's {@code sweepForEvent}).
     */
    private int sweepForEvent(long eventId) {
        List<Long> before = offerStampSet(eventId);
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

    /** The house advanceable test clock (same shape as the primary suite's). */
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
