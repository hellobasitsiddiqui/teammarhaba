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
import java.time.Duration;
import java.time.Instant;
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

/**
 * The lifecycle + claim notification seam (TM-397) end-to-end: real {@link EventAdminService} and
 * {@link EventRsvpService} mutations commit and their {@code @TransactionalEventListener(AFTER_COMMIT)}
 * consumer ({@link EventLifecycleNotifier}) pushes to the right people — driven through the whole
 * publish→commit→listener→fan-out chain against Postgres, with only the outermost {@link PushSender}
 * swapped for a recording fake.
 *
 * <p>Covers the ACs' notification cases: a <b>material</b> edit (start time / location) notifies the
 * {@code GOING} attendees while a description-only edit stays silent; a cancellation notifies the
 * {@code GOING} attendees and voids any live offer (kills the cascade); and a successful waitlist
 * claim confirms just the claimant. Waitlisted members are never sent an edit push — recipients are
 * {@code GOING} only.
 */
@Import(EventLifecycleNotifierIntegrationTest.RecordingSenderConfig.class)
class EventLifecycleNotifierIntegrationTest extends AbstractIntegrationTest {

    @Autowired private EventAdminService admin;
    @Autowired private EventRsvpService rsvps;
    @Autowired private EventRepository events;
    @Autowired private EventAttendanceRepository attendance;
    @Autowired private UserRepository users;
    @Autowired private DeviceTokenRepository deviceTokens;
    @Autowired private RecordingPushSender sender;

    @BeforeEach
    void cleanSlate() {
        attendance.deleteAll();
        deviceTokens.deleteAll();
        sender.reset();
    }

    @AfterEach
    void leaveNoResidue() {
        attendance.deleteAll();
        deviceTokens.deleteAll();
    }

    // ------------------------------------------------------------------ material edit filter

    @Test
    void materialStartTimeEditNotifiesOnlyGoingAttendees() {
        Event event = createEvent(1);
        VerifiedUser going = attendee("mat-going", NotificationPref.PUSH, "tok-mat-going");
        VerifiedUser waitlisted = attendee("mat-wait", NotificationPref.PUSH, "tok-mat-wait");
        rsvps.rsvp(going, event.getId()); // GOING (fills capacity 1)
        rsvps.rsvp(waitlisted, event.getId()); // WAITLISTED
        sender.reset();

        admin.update(admin(), event.getId(), patchStartAt(event.getStartAt().plus(Duration.ofHours(1))));

        List<Delivery> pushes = pushesTitled("Event updated:");
        assertThat(pushes).extracting(d -> d.token()).containsExactly("tok-mat-going"); // GOING only
        assertThat(pushes.get(0).message().title()).isEqualTo("Event updated: " + event.getHeading());
        assertThat(pushes.get(0).message().body()).contains("start time");
        assertThat(pushes.get(0).message().route()).isEqualTo("#/events/" + event.getId());
    }

    @Test
    void locationEditIsMaterialAndNamesTheLocation() {
        Event event = createEvent(5);
        VerifiedUser going = attendee("loc-going", NotificationPref.PUSH, "tok-loc-going");
        rsvps.rsvp(going, event.getId());
        sender.reset();

        admin.update(admin(), event.getId(), patchLocation("New Venue, 99 Side St"));

        List<Delivery> pushes = pushesTitled("Event updated:");
        assertThat(pushes).extracting(Delivery::token).containsExactly("tok-loc-going");
        // The event starts in 2h — past its default 24h reveal boundary — so the update push names the
        // new venue (TM-416: post-reveal pushes include location).
        assertThat(pushes.get(0).message().body()).contains("location").contains("New Venue, 99 Side St");
    }

    @Test
    void nonMaterialDescriptionEditDoesNotNotify() {
        Event event = createEvent(5);
        VerifiedUser going = attendee("desc-going", NotificationPref.PUSH, "tok-desc-going");
        rsvps.rsvp(going, event.getId());
        sender.reset();

        admin.update(admin(), event.getId(), patchDescription("A tiny typo fix in the description."));

        assertThat(sender.deliveries()).isEmpty(); // a description tweak is not material — nobody is pushed
    }

    // ------------------------------------------------------------------ cancel

    @Test
    void cancellationNotifiesGoingAttendeesAndKillsTheCascade() {
        Event event = createEvent(2);
        VerifiedUser a = attendee("cancel-a", NotificationPref.PUSH, "tok-cancel-a");
        VerifiedUser b = attendee("cancel-b", NotificationPref.PUSH, "tok-cancel-b");
        VerifiedUser waitlisted = attendee("cancel-w", NotificationPref.PUSH, "tok-cancel-w");
        rsvps.rsvp(a, event.getId()); // GOING
        rsvps.rsvp(b, event.getId()); // GOING (capacity 2 now full)
        rsvps.rsvp(waitlisted, event.getId()); // WAITLISTED
        stampOffer(event.getId(), idOf(waitlisted)); // pretend the cascade had already offered them
        sender.reset();

        admin.cancel(admin(), event.getId());

        // GOING attendees are told; the waitlisted member is not (recipients = GOING).
        assertThat(pushesTitled("Event cancelled:"))
                .extracting(Delivery::token)
                .containsExactlyInAnyOrder("tok-cancel-a", "tok-cancel-b");
        // The running cascade is killed: the live offer is voided.
        assertThat(attendance
                        .findByEventIdAndUserId(event.getId(), idOf(waitlisted))
                        .orElseThrow()
                        .getOfferNotifiedAt())
                .isNull();
    }

    // ------------------------------------------------------------------ claim confirmation

    @Test
    void successfulClaimConfirmsOnlyTheClaimant() {
        Event event = createEvent(1);
        VerifiedUser a = attendee("claim-a", NotificationPref.PUSH, "tok-claim-a");
        VerifiedUser w1 = attendee("claim-w1", NotificationPref.PUSH, "tok-claim-w1");
        rsvps.rsvp(a, event.getId()); // GOING
        rsvps.rsvp(w1, event.getId()); // WAITLISTED
        rsvps.cancelRsvp(a, event.getId()); // frees the spot (no auto-promotion)
        sender.reset();

        rsvps.claim(w1, event.getId()); // WAITLISTED -> GOING

        List<Delivery> pushes = pushesTitled("You're in");
        assertThat(pushes).extracting(Delivery::token).containsExactly("tok-claim-w1");
        assertThat(pushes.get(0).message().title()).isEqualTo("You're in ✓");
        assertThat(pushes.get(0).message().route()).isEqualTo("#/events/" + event.getId());
    }

    @Test
    void doubleTapClaimDoesNotDoubleConfirm() {
        Event event = createEvent(2);
        VerifiedUser a = attendee("double-a", NotificationPref.PUSH, "tok-double-a");
        rsvps.rsvp(a, event.getId()); // already GOING (spot free, no waitlist)
        sender.reset();

        rsvps.claim(a, event.getId()); // idempotent double-tap on an already-GOING member

        assertThat(sender.deliveries()).isEmpty(); // no promotion happened, so no confirmation fires
    }

    // ------------------------------------------------------------------ fixtures

    private VerifiedUser admin() {
        return new VerifiedUser("lifecycle-admin", "lifecycle-admin@example.com");
    }

    /** A PUBLISHED, visible-now event starting in two hours, with the given capacity. */
    private Event createEvent(Integer capacity) {
        Instant now = Instant.now();
        Instant startAt = now.plus(Duration.ofHours(2));
        EventDraft draft = new EventDraft(
                "Lifecycle " + UUID.randomUUID(),
                "Original description",
                "Marhaba Cafe, 12 High St",
                null,
                null,
                null,
                "Europe/London",
                startAt,
                null,
                now.minus(Duration.ofDays(1)),
                startAt.plus(Duration.ofDays(7)),
                capacity,
                null,
                null,
                null,
                null);
        return admin.create(admin(), draft);
    }

    /** A caller backed by a real user with the given pref + one device token (idempotent per uid). */
    private VerifiedUser attendee(String tag, NotificationPref pref, String token) {
        String uid = "lifecycle-" + tag;
        User user = users.findByFirebaseUid(uid)
                .orElseGet(() -> users.saveAndFlush(new User(uid, uid + "@example.com", null)));
        user.setNotificationPref(pref);
        long userId = users.saveAndFlush(user).getId();
        deviceTokens.saveAndFlush(new DeviceToken(userId, token, DevicePlatform.ANDROID, Instant.now()));
        return new VerifiedUser(uid, uid + "@example.com");
    }

    private long idOf(VerifiedUser caller) {
        return users.findByFirebaseUid(caller.uid()).orElseThrow().getId();
    }

    private void stampOffer(long eventId, long userId) {
        EventAttendance row = attendance.findByEventIdAndUserId(eventId, userId).orElseThrow();
        row.recordOffer(Instant.now());
        attendance.saveAndFlush(row);
    }

    private static EventPatch patchStartAt(Instant startAt) {
        return new EventPatch(
                null, null, null, null, null, null, null, startAt, null, null, null, null, null, null, null, null);
    }

    private static EventPatch patchLocation(String locationText) {
        return new EventPatch(
                null, null, locationText, null, null, null, null, null, null, null, null, null, null, null, null,
                null);
    }

    private static EventPatch patchDescription(String description) {
        return new EventPatch(
                null, description, null, null, null, null, null, null, null, null, null, null, null, null, null,
                null);
    }

    private List<Delivery> pushesTitled(String titlePrefix) {
        return sender.deliveries().stream()
                .filter(d -> d.message().title().startsWith(titlePrefix))
                .toList();
    }

    // ------------------------------------------------------------------ harness

    @TestConfiguration
    static class RecordingSenderConfig {
        @Bean
        @Primary
        RecordingPushSender recordingPushSender() {
            return new RecordingPushSender();
        }
    }

    record Delivery(String token, PushMessage message) {}

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
}
