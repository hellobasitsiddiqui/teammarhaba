package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.startsWith;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.config.LocationRevealProperties;
import com.teammarhaba.backend.event.EventLifecycleEvent.Kind;
import com.teammarhaba.backend.notify.NotificationType;
import com.teammarhaba.backend.notify.NotificationWriter;
import com.teammarhaba.backend.notify.PushMessage;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * {@link EventLifecycleNotifier}'s branching rules (TM-397) against mocked collaborators — the actual
 * delivery mechanics live behind the {@link EventAttendeeNotifier} rails (covered by the integration
 * tests). Here we pin the policy this class owns: the material-change filter (which UPDATED edits
 * notify), CREATE staying silent, CANCELLED killing the cascade and notifying, and the claim
 * confirmation targeting exactly the claimant.
 */
@ExtendWith(MockitoExtension.class)
class EventLifecycleNotifierTest {

    private static final long EVENT_ID = 42L;
    private static final String HEADING = "Iftar Meetup";
    private static final Instant NOW = Instant.parse("2026-07-03T12:00:00Z");

    @Mock private EventAttendanceRepository attendance;
    @Mock private EventRepository events;
    @Mock private EventAttendeeNotifier notifier;
    @Mock private WaitlistOfferCascadeService cascade;
    @Mock private NotificationWriter writer;

    // Real reveal helper (default 24h window) + fixed clock so the reveal boundary is deterministic.
    private final Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);
    private final EventPushLocation pushLocation =
            new EventPushLocation(new LocationRevealPolicy(new LocationRevealProperties(null, Map.of())));

    private EventLifecycleNotifier notifierUnderTest() {
        return new EventLifecycleNotifier(attendance, events, notifier, cascade, pushLocation, writer, clock);
    }

    /** An event starting at {@code startAt} with the given venue (default 24h reveal, no override). */
    private Event eventAt(Instant startAt, String locationText) {
        return new Event(
                HEADING,
                "desc",
                locationText,
                "Europe/London",
                startAt,
                startAt.minus(Duration.ofDays(7)),
                startAt.plus(Duration.ofDays(7)),
                9L,
                NOW);
    }

    private EventLifecycleEvent updated(Set<String> changedFields) {
        return new EventLifecycleEvent(EVENT_ID, HEADING, Kind.UPDATED, changedFields);
    }

    private void stubGoing(long... userIds) {
        List<EventAttendance> rows = new java.util.ArrayList<>();
        for (long id : userIds) {
            rows.add(new EventAttendance(EVENT_ID, id, AttendanceState.GOING));
        }
        when(attendance.findByEventIdAndState(EVENT_ID, AttendanceState.GOING)).thenReturn(rows);
    }

    // ------------------------------------------------------------------ material edit filter

    @Test
    void startTimeEditNotifiesGoingAttendees() {
        stubGoing(1L, 2L);

        notifierUnderTest().onLifecycle(updated(Set.of("startAt")));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<Long>> recipients = ArgumentCaptor.forClass(List.class);
        ArgumentCaptor<PushMessage> message = ArgumentCaptor.forClass(PushMessage.class);
        verify(notifier).pushToUsers(recipients.capture(), message.capture());
        assertThat(recipients.getValue()).containsExactly(1L, 2L);
        assertThat(message.getValue().title()).isEqualTo("Event updated: " + HEADING);
        assertThat(message.getValue().body()).contains("start time");
        assertThat(message.getValue().route()).isEqualTo("#/events/" + EVENT_ID);

        // ...and the same edit is written to the durable inbox for those same GOING attendees (TM-453),
        // typed EVENT_UPDATED with an event-scoped, versioned idempotency key.
        verify(writer)
                .writeSystem(
                        eq(NotificationType.EVENT_UPDATED),
                        eq(List.of(1L, 2L)),
                        any(PushMessage.class),
                        startsWith("event:" + EVENT_ID + ":updated"));
    }

    @Test
    void timezoneEditIsMaterialToo() {
        // A timezone change moves the local start an attendee plans around — material by the same logic.
        stubGoing(1L);

        notifierUnderTest().onLifecycle(updated(Set.of("timezone")));

        verify(notifier).pushToUsers(anyCollection(), any(PushMessage.class));
    }

    @Test
    void locationEditIsMaterialAndNamesTheLocation() {
        stubGoing(1L);

        notifierUnderTest().onLifecycle(updated(Set.of("locationText")));

        ArgumentCaptor<PushMessage> message = ArgumentCaptor.forClass(PushMessage.class);
        verify(notifier).pushToUsers(anyCollection(), message.capture());
        assertThat(message.getValue().body()).contains("location");
    }

    @Test
    void bothTimeAndLocationEditNamesBoth() {
        stubGoing(1L);

        notifierUnderTest().onLifecycle(updated(Set.of("startAt", "locationText")));

        ArgumentCaptor<PushMessage> message = ArgumentCaptor.forClass(PushMessage.class);
        verify(notifier).pushToUsers(anyCollection(), message.capture());
        assertThat(message.getValue().body()).contains("time and location");
    }

    // ------------------------------------------------------------------ location reveal (TM-416)

    @Test
    void locationEditAfterRevealNamesTheNewVenue() {
        // Event starts in 1h — well past its 24h reveal boundary — so the update push may name where
        // it moved to (TM-416: post-reveal pushes include location).
        stubGoing(1L);
        when(events.findById(EVENT_ID))
                .thenReturn(Optional.of(eventAt(NOW.plus(Duration.ofHours(1)), "New Venue, 99 Side St")));

        notifierUnderTest().onLifecycle(updated(Set.of("locationText")));

        ArgumentCaptor<PushMessage> message = ArgumentCaptor.forClass(PushMessage.class);
        verify(notifier).pushToUsers(anyCollection(), message.capture());
        assertThat(message.getValue().body()).contains("location").contains("New Venue, 99 Side St");
    }

    @Test
    void locationEditBeforeRevealWithholdsTheNewVenue() {
        // Same edit, but the event is 100 days out (default 24h reveal window not yet open): the new
        // address must NOT appear — the push just points at the app, closing the leak (TM-416 AC1).
        stubGoing(1L);
        when(events.findById(EVENT_ID))
                .thenReturn(Optional.of(eventAt(NOW.plus(Duration.ofDays(100)), "Secret Venue, 5 Hidden Ln")));

        notifierUnderTest().onLifecycle(updated(Set.of("locationText")));

        ArgumentCaptor<PushMessage> message = ArgumentCaptor.forClass(PushMessage.class);
        verify(notifier).pushToUsers(anyCollection(), message.capture());
        assertThat(message.getValue().body())
                .doesNotContain("Secret Venue", "5 Hidden Ln")
                .contains("location")
                .contains("tap for details");
    }

    @Test
    void nonMaterialEditsNeverNotify() {
        EventLifecycleNotifier notifierUnderTest = notifierUnderTest();

        // Description, end time, capacity, image, visibility window, urls — none is material.
        notifierUnderTest.onLifecycle(updated(Set.of("description")));
        notifierUnderTest.onLifecycle(updated(Set.of("endAt")));
        notifierUnderTest.onLifecycle(updated(Set.of("capacity")));
        notifierUnderTest.onLifecycle(updated(Set.of("imagePath")));
        notifierUnderTest.onLifecycle(updated(Set.of("visibilityStart", "visibilityEnd")));
        notifierUnderTest.onLifecycle(updated(Set.of("mapUrl", "onlineUrl")));
        notifierUnderTest.onLifecycle(updated(Set.of())); // (belt-and-braces; the admin service never emits this)

        // No recipients ever resolved, nothing pushed, nothing written — a non-material edit is silent.
        verifyNoInteractions(notifier, cascade, attendance, events, writer);
    }

    @Test
    void mixedMaterialAndCosmeticEditStillNotifies() {
        // A single PATCH that changes the start time AND fixes a typo is material on the strength of
        // the start time alone.
        stubGoing(1L);

        notifierUnderTest().onLifecycle(updated(Set.of("startAt", "description")));

        verify(notifier).pushToUsers(anyCollection(), any(PushMessage.class));
    }

    // ------------------------------------------------------------------ create / cancel / claim

    @Test
    void createNotifiesNobodyAndTouchesNothing() {
        notifierUnderTest().onLifecycle(new EventLifecycleEvent(EVENT_ID, HEADING, Kind.CREATED));

        verifyNoInteractions(notifier, cascade, attendance, events, writer);
    }

    @Test
    void cancellationKillsTheCascadeAndNotifiesGoingAttendees() {
        stubGoing(1L, 2L);

        notifierUnderTest().onLifecycle(new EventLifecycleEvent(EVENT_ID, HEADING, Kind.CANCELLED));

        verify(cascade).killCascade(EVENT_ID); // stop any running offer cascade
        ArgumentCaptor<PushMessage> message = ArgumentCaptor.forClass(PushMessage.class);
        verify(notifier).pushToUsers(anyCollection(), message.capture());
        assertThat(message.getValue().title()).isEqualTo("Event cancelled: " + HEADING);
        assertThat(message.getValue().body()).contains("called off");

        // The cancellation is also written to the durable inbox for the GOING attendees (TM-453).
        verify(writer)
                .writeSystem(
                        eq(NotificationType.EVENT_CANCELLED),
                        eq(List.of(1L, 2L)),
                        any(PushMessage.class),
                        eq("event:" + EVENT_ID + ":cancelled"));
    }

    @Test
    void claimConfirmsExactlyTheClaimant() {
        notifierUnderTest().onClaimed(new EventClaimedEvent(EVENT_ID, 7L, HEADING, NOW));

        ArgumentCaptor<PushMessage> message = ArgumentCaptor.forClass(PushMessage.class);
        verify(notifier).pushToUser(eq(7L), message.capture());
        assertThat(message.getValue().title()).isEqualTo("You're in ✓");
        assertThat(message.getValue().route()).isEqualTo("#/events/" + EVENT_ID);

        // The confirmation is written to just the claimant's durable inbox, typed RSVP_CONFIRMED, with
        // an idempotency key scoped to THIS claim episode (the claim instant), not a static per-event
        // key — so a later re-claim writes a fresh row rather than being suppressed (TM-555).
        verify(writer)
                .writeSystemToUser(
                        eq(NotificationType.RSVP_CONFIRMED),
                        eq(7L),
                        any(PushMessage.class),
                        eq("event:" + EVENT_ID + ":rsvp:" + NOW.toEpochMilli()));
    }

    @Test
    void distinctClaimEpisodesGetDistinctSourceRefs() {
        // Two genuine promotions of the same user to the same event (leave+rejoin+re-claim) commit at
        // different instants, so each writes under its own key — the writer sees two distinct source
        // refs and cannot suppress the second as a duplicate of the first (TM-555).
        Instant firstClaim = NOW;
        Instant secondClaim = NOW.plus(Duration.ofMinutes(30));

        notifierUnderTest().onClaimed(new EventClaimedEvent(EVENT_ID, 7L, HEADING, firstClaim));
        notifierUnderTest().onClaimed(new EventClaimedEvent(EVENT_ID, 7L, HEADING, secondClaim));

        ArgumentCaptor<String> sourceRef = ArgumentCaptor.forClass(String.class);
        verify(writer, times(2))
                .writeSystemToUser(eq(NotificationType.RSVP_CONFIRMED), eq(7L), any(PushMessage.class), sourceRef.capture());
        assertThat(sourceRef.getAllValues())
                .containsExactly(
                        "event:" + EVENT_ID + ":rsvp:" + firstClaim.toEpochMilli(),
                        "event:" + EVENT_ID + ":rsvp:" + secondClaim.toEpochMilli());
    }
}
