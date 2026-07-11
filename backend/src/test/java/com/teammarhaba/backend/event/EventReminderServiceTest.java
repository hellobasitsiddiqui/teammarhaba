package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.config.LocationRevealProperties;
import com.teammarhaba.backend.device.DevicePlatform;
import com.teammarhaba.backend.device.DeviceToken;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.notify.NotificationType;
import com.teammarhaba.backend.notify.NotificationWriter;
import com.teammarhaba.backend.notify.PushMessage;
import com.teammarhaba.backend.notify.PushNotificationService;
import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
import com.teammarhaba.backend.user.NotificationPref;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;

/**
 * {@link EventReminderService} due-ness, recipient rails, idempotency and content rules (TM-394),
 * against mocked collaborators — the real delivery mechanics live behind the shared
 * {@link PushNotificationService} seam (covered by its own tests), so here we assert this
 * service's rules: which milestones fire when (incl. the late-creation rule and never-after-start),
 * GOING-only recipients resolved through {@code User} with the broadcast rails (opt-out, disabled,
 * not-found, shared-token de-dup), the claim-first idempotency (pre-filter, unique-violation race
 * loser, cancelled-after-claim re-check), and the title/body/route content contract.
 */
@ExtendWith(MockitoExtension.class)
class EventReminderServiceTest {

    private static final Instant T0 = Instant.parse("2026-07-03T12:00:00Z");
    private static final long EVENT_ID = 42L;
    private static final long CREATOR = 9L;

    @Mock private EventRepository events;
    @Mock private EventAttendanceRepository attendance;
    @Mock private EventReminderSendRepository markers;
    @Mock private UserRepository users;
    @Mock private DeviceTokenRepository deviceTokens;
    @Mock private PushNotificationService push;
    @Mock private NotificationWriter writer;

    // A real reveal helper (default 24h app window, no per-city overrides) so the location gate is
    // exercised end-to-end against the actual policy rather than a mock (TM-416).
    private final EventPushLocation pushLocation =
            new EventPushLocation(new LocationRevealPolicy(new LocationRevealProperties(null, Map.of())));

    private EventReminderService service() {
        return new EventReminderService(
                events,
                attendance,
                markers,
                users,
                deviceTokens,
                push,
                pushLocation,
                writer,
                Clock.fixed(T0, java.time.ZoneOffset.UTC));
    }

    // ------------------------------------------------------------------ fixtures

    /** An event with reflect-set id/createdAt (DB-authoritative columns the constructor can't set). */
    private Event event(long id, Instant startAt, Instant createdAt) {
        Event e = new Event(
                "Iftar Meetup",
                "Community iftar",
                "Marhaba Cafe, 12 High St",
                "Europe/London",
                startAt,
                startAt.minus(Duration.ofDays(7)),
                startAt,
                CREATOR,
                createdAt);
        setField(Event.class, e, "id", id);
        setField(Event.class, e, "createdAt", createdAt);
        return e;
    }

    private User user(long id, NotificationPref pref) {
        User u = new User("uid-" + id, "u" + id + "@example.com", null);
        setField(User.class, u, "id", id);
        u.setNotificationPref(pref);
        return u;
    }

    private static void setField(Class<?> type, Object target, String name, Object value) {
        try {
            var field = type.getDeclaredField(name);
            field.setAccessible(true);
            field.set(target, value);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    private void stubScanReturns(Event... found) {
        when(events.findStartingBetween(EventStatus.PUBLISHED, T0, T0.plus(ReminderMilestone.SCAN_HORIZON)))
                .thenReturn(List.of(found));
    }

    /** Claim insert succeeds (echoes the marker back, as the real repo does). */
    private void stubClaimSucceeds() {
        when(markers.saveAndFlush(any(EventReminderSend.class))).thenAnswer(inv -> inv.getArgument(0));
    }

    /** Device tokens per user, resolved in one batch by the service (findByUserIdIn, TM-525). */
    private final Map<Long, List<DeviceToken>> tokensByUser = new HashMap<>();

    /**
     * Stub the single batched token read the service now performs: given the eligible user ids, return
     * the union of their registered tokens in id order (so token de-dup/order assertions stay stable).
     * Lenient because the many due-ness/idempotency tests never reach the fan-out.
     */
    @BeforeEach
    void stubBatchedTokenRead() {
        lenient().when(deviceTokens.findByUserIdIn(anyCollection())).thenAnswer(inv -> {
            Collection<Long> ids = inv.getArgument(0);
            List<DeviceToken> union = new ArrayList<>();
            for (Long id : ids) {
                union.addAll(tokensByUser.getOrDefault(id, List.of()));
            }
            return union;
        });
    }

    private void stubTokens(long userId, String... tokenValues) {
        List<DeviceToken> devices = new ArrayList<>();
        for (String t : tokenValues) {
            devices.add(new DeviceToken(userId, t, DevicePlatform.ANDROID, T0));
        }
        tokensByUser.put(userId, devices);
    }

    private static EventAttendance going(long eventId, long userId) {
        return new EventAttendance(eventId, userId, AttendanceState.GOING);
    }

    // ------------------------------------------------------------------ due-ness

    @Test
    void oneHourMilestoneSendsWhenDue() {
        // Created well before the window, starts in 30 min: T-1h is due, T-24h was already sent
        // (simulated by an existing marker) — only the 1h reminder goes out this tick.
        Event e = event(EVENT_ID, T0.plus(Duration.ofMinutes(30)), T0.minus(Duration.ofDays(2)));
        stubScanReturns(e);
        EventReminderSend prior = new EventReminderSend(EVENT_ID, ReminderMilestone.T_MINUS_24H);
        when(markers.findByEventIdIn(List.of(EVENT_ID))).thenReturn(List.of(prior));
        stubClaimSucceeds();
        when(events.findById(EVENT_ID)).thenReturn(Optional.of(e));
        when(attendance.findByEventIdAndState(EVENT_ID, AttendanceState.GOING))
                .thenReturn(List.of(going(EVENT_ID, 1L)));
        when(users.findAllById(List.of(1L))).thenReturn(List.of(user(1L, NotificationPref.PUSH)));
        stubTokens(1L, "tok-1");
        when(push.sendToTokens(anyCollection(), any(PushMessage.class))).thenReturn(new PushFanout(1, 1, 0, 0));

        assertThat(service().remindDueEvents()).isEqualTo(1);

        ArgumentCaptor<EventReminderSend> claimed = ArgumentCaptor.forClass(EventReminderSend.class);
        verify(markers).saveAndFlush(claimed.capture());
        assertThat(claimed.getValue().getMilestone()).isEqualTo(ReminderMilestone.T_MINUS_1H);

        // The reminder is also written to the GOING attendee's durable inbox (TM-453), typed
        // EVENT_REMINDER with an (event, milestone)-scoped idempotency key.
        verify(writer)
                .writeSystem(
                        eq(NotificationType.EVENT_REMINDER),
                        eq(List.of(1L)),
                        any(PushMessage.class),
                        eq("event:" + EVENT_ID + ":reminder:" + ReminderMilestone.T_MINUS_1H.name()));
    }

    @Test
    void bothMilestonesSendWhenBothDueAndUnclaimed() {
        // Downtime-recovery shape: created long ago, starts in 30 min, nothing sent yet — both
        // milestones are due (still before start) and each sends, at most once, 24h first.
        Event e = event(EVENT_ID, T0.plus(Duration.ofMinutes(30)), T0.minus(Duration.ofDays(2)));
        stubScanReturns(e);
        when(markers.findByEventIdIn(List.of(EVENT_ID))).thenReturn(List.of());
        stubClaimSucceeds();
        when(events.findById(EVENT_ID)).thenReturn(Optional.of(e));
        when(attendance.findByEventIdAndState(EVENT_ID, AttendanceState.GOING))
                .thenReturn(List.of(going(EVENT_ID, 1L)));
        when(users.findAllById(List.of(1L))).thenReturn(List.of(user(1L, NotificationPref.PUSH)));
        stubTokens(1L, "tok-1");
        when(push.sendToTokens(anyCollection(), any(PushMessage.class))).thenReturn(new PushFanout(1, 1, 0, 0));

        assertThat(service().remindDueEvents()).isEqualTo(2);

        ArgumentCaptor<EventReminderSend> claims = ArgumentCaptor.forClass(EventReminderSend.class);
        verify(markers, org.mockito.Mockito.times(2)).saveAndFlush(claims.capture());
        assertThat(claims.getAllValues())
                .extracting(EventReminderSend::getMilestone)
                .containsExactly(ReminderMilestone.T_MINUS_24H, ReminderMilestone.T_MINUS_1H);
    }

    @Test
    void notYetDueMilestonesDoNothing() {
        // Starts in 2h, created long ago: 24h already sent (marker), 1h not due for another hour.
        Event e = event(EVENT_ID, T0.plus(Duration.ofHours(2)), T0.minus(Duration.ofDays(2)));
        stubScanReturns(e);
        when(markers.findByEventIdIn(List.of(EVENT_ID)))
                .thenReturn(List.of(new EventReminderSend(EVENT_ID, ReminderMilestone.T_MINUS_24H)));

        assertThat(service().remindDueEvents()).isZero();
        verify(markers, never()).saveAndFlush(any());
        verifyNoInteractions(push);
    }

    @Test
    void neverRemindsOnceTheEventHasStarted() {
        // Defensive re-assert of the query's own bound: a candidate at/past start sends nothing.
        Event e = event(EVENT_ID, T0, T0.minus(Duration.ofDays(2)));
        stubScanReturns(e);
        when(markers.findByEventIdIn(List.of(EVENT_ID))).thenReturn(List.of());

        assertThat(service().remindDueEvents()).isZero();
        verify(markers, never()).saveAndFlush(any());
        verifyNoInteractions(push);
    }

    // ------------------------------------------------------------------ late creation

    @Test
    void lateCreatedEventGetsOnlyStillFutureMilestones() {
        // Created 2h before start (inside the 24h window): the T-24h fire time predates creation,
        // so only the T-1h milestone — still in the future at creation — ever fires.
        Instant createdAt = T0.minus(Duration.ofMinutes(90));
        Event e = event(EVENT_ID, T0.plus(Duration.ofMinutes(30)), createdAt);
        stubScanReturns(e);
        when(markers.findByEventIdIn(List.of(EVENT_ID))).thenReturn(List.of());
        stubClaimSucceeds();
        when(events.findById(EVENT_ID)).thenReturn(Optional.of(e));
        when(attendance.findByEventIdAndState(EVENT_ID, AttendanceState.GOING))
                .thenReturn(List.of(going(EVENT_ID, 1L)));
        when(users.findAllById(List.of(1L))).thenReturn(List.of(user(1L, NotificationPref.PUSH)));
        stubTokens(1L, "tok-1");
        when(push.sendToTokens(anyCollection(), any(PushMessage.class))).thenReturn(new PushFanout(1, 1, 0, 0));

        assertThat(service().remindDueEvents()).isEqualTo(1);

        ArgumentCaptor<EventReminderSend> claimed = ArgumentCaptor.forClass(EventReminderSend.class);
        verify(markers).saveAndFlush(claimed.capture());
        assertThat(claimed.getValue().getMilestone()).isEqualTo(ReminderMilestone.T_MINUS_1H);
    }

    @Test
    void eventCreatedInsideTheLastHourGetsNoRemindersAtAll() {
        // Created 20 min before start: both fire times predate creation — silence, not a burst.
        Instant createdAt = T0.minus(Duration.ofMinutes(5));
        Event e = event(EVENT_ID, T0.plus(Duration.ofMinutes(15)), createdAt);
        stubScanReturns(e);
        when(markers.findByEventIdIn(List.of(EVENT_ID))).thenReturn(List.of());

        assertThat(service().remindDueEvents()).isZero();
        verify(markers, never()).saveAndFlush(any());
        verifyNoInteractions(push);
    }

    // ------------------------------------------------------------------ idempotency & races

    @Test
    void existingMarkerMeansNoResend() {
        Event e = event(EVENT_ID, T0.plus(Duration.ofMinutes(30)), T0.minus(Duration.ofDays(2)));
        stubScanReturns(e);
        when(markers.findByEventIdIn(List.of(EVENT_ID)))
                .thenReturn(List.of(
                        new EventReminderSend(EVENT_ID, ReminderMilestone.T_MINUS_24H),
                        new EventReminderSend(EVENT_ID, ReminderMilestone.T_MINUS_1H)));

        assertThat(service().remindDueEvents()).isZero();
        verify(markers, never()).saveAndFlush(any());
        verifyNoInteractions(push);
    }

    @Test
    void claimRaceLoserSkipsWithoutSending() {
        // Another instance inserted the (event, milestone) row between our pre-filter and claim:
        // the unique violation is the loser's signal — no push, no error, tick carries on.
        Event e = event(EVENT_ID, T0.plus(Duration.ofMinutes(30)), T0.minus(Duration.ofDays(2)));
        stubScanReturns(e);
        when(markers.findByEventIdIn(List.of(EVENT_ID)))
                .thenReturn(List.of(new EventReminderSend(EVENT_ID, ReminderMilestone.T_MINUS_24H)));
        when(markers.saveAndFlush(any(EventReminderSend.class)))
                .thenThrow(new DataIntegrityViolationException("duplicate key"));

        assertThat(service().remindDueEvents()).isZero();
        verifyNoInteractions(push);
    }

    @Test
    void cancelledBetweenScanAndSendIsNotPushed() {
        // Scan saw it PUBLISHED, but by send time the event was cancelled: the pre-send re-check
        // wins — the claim is spent as a no-op and nobody is nudged for a dead event.
        Event scanned = event(EVENT_ID, T0.plus(Duration.ofMinutes(30)), T0.minus(Duration.ofDays(2)));
        Event cancelled = event(EVENT_ID, T0.plus(Duration.ofMinutes(30)), T0.minus(Duration.ofDays(2)));
        cancelled.cancel(T0);
        stubScanReturns(scanned);
        when(markers.findByEventIdIn(List.of(EVENT_ID)))
                .thenReturn(List.of(new EventReminderSend(EVENT_ID, ReminderMilestone.T_MINUS_24H)));
        stubClaimSucceeds();
        when(events.findById(EVENT_ID)).thenReturn(Optional.of(cancelled));

        assertThat(service().remindDueEvents()).isZero();
        verifyNoInteractions(push);
        verify(markers, never()).save(any()); // no fan-out back-fill either
    }

    @Test
    void scanOnlyEverAsksForPublishedEvents() {
        when(events.findStartingBetween(eq(EventStatus.PUBLISHED), any(), any())).thenReturn(List.of());

        assertThat(service().remindDueEvents()).isZero();

        // The status filter IS the "cancelled events never remind" first line of defence.
        verify(events).findStartingBetween(EventStatus.PUBLISHED, T0, T0.plus(ReminderMilestone.SCAN_HORIZON));
        verifyNoInteractions(push, markers, attendance, users, deviceTokens);
    }

    // ------------------------------------------------------------------ recipients

    @Test
    void goingAttendeesOnlyWithBroadcastRailsAndTokenDedupe() {
        Event e = event(EVENT_ID, T0.plus(Duration.ofMinutes(30)), T0.minus(Duration.ofDays(2)));
        stubScanReturns(e);
        when(markers.findByEventIdIn(List.of(EVENT_ID)))
                .thenReturn(List.of(new EventReminderSend(EVENT_ID, ReminderMilestone.T_MINUS_24H)));
        stubClaimSucceeds();
        when(events.findById(EVENT_ID)).thenReturn(Optional.of(e));

        // GOING rows: eligible(1), opted-out(2), disabled(3), soft-deleted/unknown(4), shared-device(5).
        when(attendance.findByEventIdAndState(EVENT_ID, AttendanceState.GOING))
                .thenReturn(List.of(
                        going(EVENT_ID, 1L),
                        going(EVENT_ID, 2L),
                        going(EVENT_ID, 3L),
                        going(EVENT_ID, 4L),
                        going(EVENT_ID, 5L)));
        User eligible = user(1L, NotificationPref.PUSH);
        User optedOut = user(2L, NotificationPref.EMAIL);
        User disabled = user(3L, NotificationPref.BOTH);
        setField(User.class, disabled, "enabled", false);
        User sharer = user(5L, NotificationPref.BOTH);
        // findAllById resolves THROUGH the User aggregate: id 4 (tombstoned) simply isn't returned.
        when(users.findAllById(List.of(1L, 2L, 3L, 4L, 5L)))
                .thenReturn(List.of(eligible, optedOut, disabled, sharer));
        stubTokens(1L, "tok-a", "tok-b");
        stubTokens(5L, "tok-a", "tok-c"); // tok-a shared with user 1 — must be pushed once
        when(push.sendToTokens(anyCollection(), any(PushMessage.class))).thenReturn(new PushFanout(3, 3, 0, 0));

        assertThat(service().remindDueEvents()).isEqualTo(1);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Collection<String>> sent = ArgumentCaptor.forClass(Collection.class);
        verify(push).sendToTokens(sent.capture(), any(PushMessage.class));
        assertThat(sent.getValue()).containsExactly("tok-a", "tok-b", "tok-c");
        // One batched token read (TM-525), and it asks for ONLY the eligible ids — the opted-out (2),
        // disabled (3) and tombstoned (4) attendees are filtered by the rails first, so their tokens
        // are never even resolved.
        verify(deviceTokens).findByUserIdIn(List.of(1L, 5L));
        verify(deviceTokens, never()).findByUserId(any());
    }

    @Test
    void noEligibleDevicesStillSpendsTheClaimWithoutSending() {
        // All attendees opted out: the reminder is spent (claimed) but the push seam is never hit —
        // same "capacity to receive is the recipient's own state" stance as broadcast.
        Event e = event(EVENT_ID, T0.plus(Duration.ofMinutes(30)), T0.minus(Duration.ofDays(2)));
        stubScanReturns(e);
        when(markers.findByEventIdIn(List.of(EVENT_ID)))
                .thenReturn(List.of(new EventReminderSend(EVENT_ID, ReminderMilestone.T_MINUS_24H)));
        stubClaimSucceeds();
        when(events.findById(EVENT_ID)).thenReturn(Optional.of(e));
        when(attendance.findByEventIdAndState(EVENT_ID, AttendanceState.GOING))
                .thenReturn(List.of(going(EVENT_ID, 2L)));
        when(users.findAllById(List.of(2L))).thenReturn(List.of(user(2L, NotificationPref.EMAIL)));

        assertThat(service().remindDueEvents()).isEqualTo(1);
        verify(markers).saveAndFlush(any(EventReminderSend.class));
        verifyNoInteractions(push);
    }

    // ------------------------------------------------------------------ content

    @Test
    void messageCarriesHeadingLocalStartLocationAndEventDetailRoute() {
        // 12:30 UTC on 2026-07-03 is 13:30 in Europe/London (BST) — the body must show the LOCAL
        // time. Start is T0+30min, so the 1h milestone is due (and the 24h one is already claimed).
        Instant startAt = Instant.parse("2026-07-03T12:30:00Z");
        Event e = event(EVENT_ID, startAt, T0.minus(Duration.ofDays(2)));
        stubScanReturns(e);
        when(markers.findByEventIdIn(List.of(EVENT_ID)))
                .thenReturn(List.of(new EventReminderSend(EVENT_ID, ReminderMilestone.T_MINUS_24H)));
        stubClaimSucceeds();
        when(events.findById(EVENT_ID)).thenReturn(Optional.of(e));
        when(attendance.findByEventIdAndState(EVENT_ID, AttendanceState.GOING))
                .thenReturn(List.of(going(EVENT_ID, 1L)));
        when(users.findAllById(List.of(1L))).thenReturn(List.of(user(1L, NotificationPref.PUSH)));
        stubTokens(1L, "tok-1");
        when(push.sendToTokens(anyCollection(), any(PushMessage.class))).thenReturn(new PushFanout(1, 1, 0, 0));

        service().remindDueEvents();

        ArgumentCaptor<PushMessage> message = ArgumentCaptor.forClass(PushMessage.class);
        verify(push).sendToTokens(anyCollection(), message.capture());
        assertThat(message.getValue().title()).isEqualTo("Starting soon: Iftar Meetup");
        assertThat(message.getValue().body()).isEqualTo("Fri 3 Jul, 13:30 · Marhaba Cafe, 12 High St");
        assertThat(message.getValue().route()).isEqualTo("#/events/" + EVENT_ID);
    }

    // ------------------------------------------------------------------ location reveal (TM-416)

    @Test
    void shortRevealEventOmitsAddressFromTheT24hReminder() {
        // The venue only reveals 2h before start, but the 24h reminder fires 24h out — 22h before the
        // address is public. The body must carry the honest placeholder, never the address (AC1/AC3).
        Event e = event(EVENT_ID, T0.plus(Duration.ofHours(24)), T0.minus(Duration.ofDays(2)));
        e.setLocationRevealHours(2);
        stubScanReturns(e);
        when(markers.findByEventIdIn(List.of(EVENT_ID))).thenReturn(List.of());
        stubClaimSucceeds();
        when(events.findById(EVENT_ID)).thenReturn(Optional.of(e));
        when(attendance.findByEventIdAndState(EVENT_ID, AttendanceState.GOING))
                .thenReturn(List.of(going(EVENT_ID, 1L)));
        when(users.findAllById(List.of(1L))).thenReturn(List.of(user(1L, NotificationPref.PUSH)));
        stubTokens(1L, "tok-1");
        when(push.sendToTokens(anyCollection(), any(PushMessage.class))).thenReturn(new PushFanout(1, 1, 0, 0));

        assertThat(service().remindDueEvents()).isEqualTo(1);

        ArgumentCaptor<PushMessage> message = ArgumentCaptor.forClass(PushMessage.class);
        verify(push).sendToTokens(anyCollection(), message.capture());
        assertThat(message.getValue().title()).isEqualTo("Reminder: Iftar Meetup"); // the T-24h milestone
        assertThat(message.getValue().body())
                .doesNotContain("Marhaba Cafe", "12 High St")
                .contains("Location shared ~2h before — check the app");
    }

    @Test
    void postRevealReminderIncludesTheVenue() {
        // Same short 2h reveal window, but this reminder fires inside it (T-1h, 1h out < 2h): the
        // venue is now public, so it appears in the body as normal (AC3, "post-reveal includes it").
        Event e = event(EVENT_ID, T0.plus(Duration.ofMinutes(30)), T0.minus(Duration.ofDays(2)));
        e.setLocationRevealHours(2);
        stubScanReturns(e);
        when(markers.findByEventIdIn(List.of(EVENT_ID)))
                .thenReturn(List.of(new EventReminderSend(EVENT_ID, ReminderMilestone.T_MINUS_24H)));
        stubClaimSucceeds();
        when(events.findById(EVENT_ID)).thenReturn(Optional.of(e));
        when(attendance.findByEventIdAndState(EVENT_ID, AttendanceState.GOING))
                .thenReturn(List.of(going(EVENT_ID, 1L)));
        when(users.findAllById(List.of(1L))).thenReturn(List.of(user(1L, NotificationPref.PUSH)));
        stubTokens(1L, "tok-1");
        when(push.sendToTokens(anyCollection(), any(PushMessage.class))).thenReturn(new PushFanout(1, 1, 0, 0));

        service().remindDueEvents();

        ArgumentCaptor<PushMessage> message = ArgumentCaptor.forClass(PushMessage.class);
        verify(push).sendToTokens(anyCollection(), message.capture());
        assertThat(message.getValue().title()).isEqualTo("Starting soon: Iftar Meetup"); // the T-1h milestone
        assertThat(message.getValue().body())
                .contains("Marhaba Cafe, 12 High St")
                .doesNotContain("check the app");
    }

    @Test
    void fanoutCountsAreBackFilledOntoTheClaimRow() {
        Event e = event(EVENT_ID, T0.plus(Duration.ofMinutes(30)), T0.minus(Duration.ofDays(2)));
        stubScanReturns(e);
        when(markers.findByEventIdIn(List.of(EVENT_ID)))
                .thenReturn(List.of(new EventReminderSend(EVENT_ID, ReminderMilestone.T_MINUS_24H)));
        stubClaimSucceeds();
        when(events.findById(EVENT_ID)).thenReturn(Optional.of(e));
        when(attendance.findByEventIdAndState(EVENT_ID, AttendanceState.GOING))
                .thenReturn(List.of(going(EVENT_ID, 1L)));
        when(users.findAllById(List.of(1L))).thenReturn(List.of(user(1L, NotificationPref.PUSH)));
        stubTokens(1L, "tok-1", "tok-dead");
        when(push.sendToTokens(anyCollection(), any(PushMessage.class))).thenReturn(new PushFanout(2, 1, 1, 0));

        service().remindDueEvents();

        ArgumentCaptor<EventReminderSend> updated = ArgumentCaptor.forClass(EventReminderSend.class);
        verify(markers).save(updated.capture());
        assertThat(updated.getValue().getTargeted()).isEqualTo(2);
        assertThat(updated.getValue().getDelivered()).isEqualTo(1);
        assertThat(updated.getValue().getPruned()).isEqualTo(1);
        assertThat(updated.getValue().getFailed()).isZero();
    }
}
