package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.event.EventLifecycleEvent.Kind;
import com.teammarhaba.backend.notify.PushMessage;
import java.util.List;
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

    @Mock private EventAttendanceRepository attendance;
    @Mock private EventAttendeeNotifier notifier;
    @Mock private WaitlistOfferCascadeService cascade;

    private EventLifecycleNotifier notifierUnderTest() {
        return new EventLifecycleNotifier(attendance, notifier, cascade);
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

        // No recipients ever resolved, nothing pushed — a non-material edit is fully silent.
        verifyNoInteractions(notifier, cascade, attendance);
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

        verifyNoInteractions(notifier, cascade, attendance);
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
    }

    @Test
    void claimConfirmsExactlyTheClaimant() {
        notifierUnderTest().onClaimed(new EventClaimedEvent(EVENT_ID, 7L, HEADING));

        ArgumentCaptor<PushMessage> message = ArgumentCaptor.forClass(PushMessage.class);
        verify(notifier).pushToUser(eq(7L), message.capture());
        assertThat(message.getValue().title()).isEqualTo("You're in ✓");
        assertThat(message.getValue().route()).isEqualTo("#/events/" + EVENT_ID);
    }
}
