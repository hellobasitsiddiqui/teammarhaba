package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.notify.PushDelivery;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushNotificationService;
import com.teammarhaba.backend.notify.PushSender;
import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.sql.Timestamp;
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

/**
 * The event reminder pipeline (TM-394) end-to-end against real Postgres: scan → due-ness →
 * persisted claim → recipient rails → fan-out through the real {@link PushNotificationService},
 * with only the outermost {@link PushSender} seam swapped for a recording fake (no FCM).
 *
 * <p>Covers the ACs' integration cases: a due milestone reaching exactly the eligible GOING
 * attendees' tokens (waitlisted and opted-out excluded, shared tokens once), the late-created
 * event receiving only its still-future milestones, idempotency across repeat ticks <em>and</em> a
 * "restarted" service instance (the marker is in the DB, not in memory — including a pre-existing
 * claim row blocking a resend outright), the counts back-filled onto the claim row, and a
 * cancelled event never reminding.
 *
 * <p>The service under test is constructed directly with a mutable {@link Clock} (the house test
 * seam), so "time passes" is explicit and deterministic; the background schedule itself is off in
 * the test profile ({@code app.event-reminders.enabled: false}) precisely so no live tick races
 * these assertions. Never {@code @Transactional}: each step commits like production, which is what
 * makes the claim-row semantics (and DB-authoritative {@code created_at}) real here.
 */
@Import(EventReminderIntegrationTest.RecordingSenderConfig.class)
class EventReminderIntegrationTest extends AbstractIntegrationTest {

    @Autowired private EventRepository events;
    @Autowired private EventAttendanceRepository attendance;
    @Autowired private EventReminderSendRepository markers;
    @Autowired private UserRepository users;
    @Autowired private DeviceTokenRepository deviceTokens;
    @Autowired private PushNotificationService pushService;
    @Autowired private EventPushLocation pushLocation;
    @Autowired private RecordingPushSender sender;
    @Autowired private JdbcTemplate jdbc;

    private final MutableClock clock = new MutableClock(Instant.now());

    private EventReminderService service() {
        return new EventReminderService(
                events, attendance, markers, users, deviceTokens, pushService, pushLocation, clock);
    }

    @BeforeEach
    void cleanSlate() {
        wipe();
        sender.reset();
        clock.setTo(Instant.now());
    }

    @AfterEach
    void leaveNoResidue() {
        wipe(); // good-citizen cleanup: the suite shares one DB across test classes
    }

    private void wipe() {
        markers.deleteAll();
        attendance.deleteAll();
        events.deleteAll();
        deviceTokens.deleteAll();
    }

    // ------------------------------------------------------------------ fixtures

    private long seedUser(String uid, NotificationPref pref) {
        User u = users.findByFirebaseUid(uid).orElseGet(() -> {
            User fresh = new User(uid, uid + "@example.com", null);
            return users.saveAndFlush(fresh);
        });
        u.setNotificationPref(pref);
        return users.saveAndFlush(u).getId();
    }

    private void seedToken(long userId, String token) {
        deviceTokens.saveAndFlush(new DeviceToken(userId, token, DevicePlatform.ANDROID, Instant.now()));
    }

    private Event seedEvent(String heading, Instant startAt) {
        Instant now = Instant.now();
        long creator = seedUser("rem-creator", NotificationPref.EMAIL);
        return events.saveAndFlush(new Event(
                heading,
                "Reminder pipeline test event",
                "Marhaba Cafe, 12 High St",
                "Europe/London",
                startAt,
                now.minus(Duration.ofDays(1)),
                startAt,
                creator,
                now));
    }

    /** Rewind the DB-authoritative {@code created_at} — the only way to simulate an old event. */
    private void backdateCreation(long eventId, Instant createdAt) {
        jdbc.update("update events set created_at = ? where id = ?", Timestamp.from(createdAt), eventId);
    }

    private List<ReminderMilestone> markerMilestones(long eventId) {
        return markers.findByEventIdIn(List.of(eventId)).stream()
                .map(EventReminderSend::getMilestone)
                .toList();
    }

    // ------------------------------------------------------------------ tests

    @Test
    void dueOneHourReminderReachesExactlyTheEligibleGoingTokens() {
        Instant now = Instant.now();
        Event event = seedEvent("Iftar Meetup", now.plus(Duration.ofHours(2)));

        long eligible = seedUser("rem-going-push", NotificationPref.PUSH);
        long optedOut = seedUser("rem-going-email", NotificationPref.EMAIL);
        long waitlisted = seedUser("rem-waitlisted-push", NotificationPref.PUSH);
        seedToken(eligible, "rem-tok-a");
        seedToken(eligible, "rem-tok-b");
        seedToken(optedOut, "rem-tok-optout");
        seedToken(waitlisted, "rem-tok-waitlist");
        attendance.saveAndFlush(new EventAttendance(event.getId(), eligible, AttendanceState.GOING));
        attendance.saveAndFlush(new EventAttendance(event.getId(), optedOut, AttendanceState.GOING));
        attendance.saveAndFlush(new EventAttendance(event.getId(), waitlisted, AttendanceState.WAITLISTED));

        // 70 minutes on: T-1h (due 1h before start) has passed; the event hasn't started.
        clock.setTo(now.plus(Duration.ofMinutes(70)));

        assertThat(service().remindDueEvents()).isEqualTo(1);

        // Only the push-opted-in GOING attendee's devices — both of them — were targeted.
        assertThat(sender.tokens()).containsExactlyInAnyOrder("rem-tok-a", "rem-tok-b");
        PushMessage message = sender.deliveries().get(0).message();
        assertThat(message.title()).isEqualTo("Starting soon: Iftar Meetup");
        assertThat(message.body()).contains(" · Marhaba Cafe, 12 High St");
        assertThat(message.route()).isEqualTo("#/events/" + event.getId());

        // The claim row is persisted with the fan-out back-filled. And ONLY the 1h milestone
        // exists: this event was created inside its own 24h window (the late-creation rule), so
        // the already-past T-24h milestone never fires at all.
        List<EventReminderSend> claims = markers.findByEventIdIn(List.of(event.getId()));
        assertThat(claims).hasSize(1);
        assertThat(claims.get(0).getMilestone()).isEqualTo(ReminderMilestone.T_MINUS_1H);
        assertThat(claims.get(0).getTargeted()).isEqualTo(2);
        assertThat(claims.get(0).getDelivered()).isEqualTo(2);
        assertThat(claims.get(0).getSentAt()).isNotNull(); // DB-authoritative claim instant
    }

    @Test
    void repeatTicksAndRestartedInstancesNeverResend() {
        Instant now = Instant.now();
        Event event = seedEvent("Jummah Lunch", now.plus(Duration.ofHours(2)));
        long eligible = seedUser("rem-idem-push", NotificationPref.PUSH);
        seedToken(eligible, "rem-tok-idem");
        attendance.saveAndFlush(new EventAttendance(event.getId(), eligible, AttendanceState.GOING));

        clock.setTo(now.plus(Duration.ofMinutes(70)));
        assertThat(service().remindDueEvents()).isEqualTo(1);
        assertThat(sender.tokens()).hasSize(1);

        // Same instance ticks again, later inside the window: nothing new.
        clock.setTo(now.plus(Duration.ofMinutes(80)));
        assertThat(service().remindDueEvents()).isZero();

        // A brand-new service instance ("after a restart" / another Cloud Run instance): the claim
        // lives in Postgres, not in process memory, so it still refuses to resend.
        assertThat(service().remindDueEvents()).isZero();

        assertThat(sender.tokens()).hasSize(1);
        assertThat(markerMilestones(event.getId())).containsExactly(ReminderMilestone.T_MINUS_1H);
    }

    @Test
    void oldEnoughEventSendsBothMilestonesInOrder() {
        Instant now = Instant.now();
        Event event = seedEvent("Eid Picnic", now.plus(Duration.ofMinutes(30)));
        backdateCreation(event.getId(), now.minus(Duration.ofHours(30))); // created before both windows
        long eligible = seedUser("rem-both-push", NotificationPref.PUSH);
        seedToken(eligible, "rem-tok-both");
        attendance.saveAndFlush(new EventAttendance(event.getId(), eligible, AttendanceState.GOING));

        clock.setTo(now); // both fire times are in the past; start is 30 min away

        assertThat(service().remindDueEvents()).isEqualTo(2);

        assertThat(sender.deliveries()).hasSize(2);
        assertThat(sender.deliveries().get(0).message().title()).isEqualTo("Reminder: Eid Picnic");
        assertThat(sender.deliveries().get(1).message().title()).isEqualTo("Starting soon: Eid Picnic");
        assertThat(markerMilestones(event.getId()))
                .containsExactlyInAnyOrder(ReminderMilestone.T_MINUS_24H, ReminderMilestone.T_MINUS_1H);
    }

    @Test
    void cancelledEventNeverReminds() {
        Instant now = Instant.now();
        Event event = seedEvent("Called Off", now.plus(Duration.ofMinutes(30)));
        backdateCreation(event.getId(), now.minus(Duration.ofHours(30)));
        long eligible = seedUser("rem-cancel-push", NotificationPref.PUSH);
        seedToken(eligible, "rem-tok-cancel");
        attendance.saveAndFlush(new EventAttendance(event.getId(), eligible, AttendanceState.GOING));

        Event managed = events.findById(event.getId()).orElseThrow();
        managed.cancel(now);
        events.saveAndFlush(managed);

        clock.setTo(now); // both milestones would be due — but the event is CANCELLED

        assertThat(service().remindDueEvents()).isZero();
        assertThat(sender.tokens()).isEmpty();
        assertThat(markers.count()).isZero();
    }

    @Test
    void preExistingClaimRowBlocksTheSendOutright() {
        // The multi-instance/crashed-run shape: the (event, milestone) claim already exists in the
        // DB (inserted by "someone else"), so this instance's tick must not push at all.
        Instant now = Instant.now();
        Event event = seedEvent("Claimed Elsewhere", now.plus(Duration.ofHours(2)));
        long eligible = seedUser("rem-claimed-push", NotificationPref.PUSH);
        seedToken(eligible, "rem-tok-claimed");
        attendance.saveAndFlush(new EventAttendance(event.getId(), eligible, AttendanceState.GOING));
        markers.saveAndFlush(new EventReminderSend(event.getId(), ReminderMilestone.T_MINUS_1H));

        clock.setTo(now.plus(Duration.ofMinutes(70)));

        assertThat(service().remindDueEvents()).isZero();
        assertThat(sender.tokens()).isEmpty();
        assertThat(markerMilestones(event.getId())).containsExactly(ReminderMilestone.T_MINUS_1H);
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
    record Delivery(String token, PushMessage message) {
    }

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

        synchronized List<String> tokens() {
            return deliveries.stream().map(Delivery::token).toList();
        }

        synchronized void reset() {
            deliveries.clear();
        }
    }

    /** The house advanceable test clock (same shape as {@code BroadcastServiceTest}'s). */
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
