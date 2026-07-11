package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.config.CancellationWindowProperties;
import com.teammarhaba.backend.config.MembershipProperties;
import com.teammarhaba.backend.config.ReliabilityProperties;
import com.teammarhaba.backend.membership.EntitlementService;
import com.teammarhaba.backend.membership.MembershipService;
import com.teammarhaba.backend.membership.OrderRepository;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.ConflictException;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.context.ApplicationEventPublisher;

/**
 * The reliability downgrade enforcement (TM-409) on {@link EventRsvpService}: a downgraded account (its
 * running late-cancellation strike count at/above the configured {@code downgradeThreshold}) can no
 * longer take a GOING spot on a capacity-limited event — an honest {@code 409} at RSVP and claim time —
 * but is still free to join the waitlist of a full event and to join events with no capacity limit. An
 * account below the threshold, and the feature switched off, both behave exactly as before.
 *
 * <p>Lenient stubbing: the RSVP/claim paths touch many collaborators at different depths across these
 * cases, so unused stubs are expected — the assertions (throw vs. landed state) are what pin behaviour.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class EventRsvpServiceReliabilityTest {

    private static final long EVENT_ID = 42L;
    private static final long USER_ID = 7L;
    private static final long CREATOR = 9L;

    /** The strike count that trips the downgrade under the test config (downgrade @3). */
    private static final int DOWNGRADED_STRIKES = 3;

    @Mock private EventRepository events;
    @Mock private EventAttendanceRepository attendance;
    @Mock private UserService users;
    @Mock private ApplicationEventPublisher publisher;
    @Mock private BookingCutoffPolicy bookingCutoff;
    @Mock private AgeEligibilityPolicy ageGate;
    @Mock private EventPhasePolicy phasePolicy;
    @Mock private EventChatLifecycleService chatLifecycle;
    @Mock private EntitlementService entitlements;
    @Mock private OrderRepository orders;
    @Mock private MembershipService memberships;
    @Mock private AuditService audit;

    private final VerifiedUser caller = new VerifiedUser("uid-caller", "caller@example.com");

    /** Reliability config under test: penalty 10, warn @1, downgrade @3. */
    private EventRsvpService serviceWith(boolean reliabilityEnabled) {
        ReliabilityService reliability = new ReliabilityService(
                new ReliabilityPolicy(new ReliabilityProperties(reliabilityEnabled, 10, 1, DOWNGRADED_STRIKES)),
                audit);
        return new EventRsvpService(
                events,
                attendance,
                users,
                new CancellationPolicy(new CancellationWindowProperties(24, Map.of())),
                ageGate,
                publisher,
                bookingCutoff,
                phasePolicy,
                chatLifecycle,
                new MembershipProperties(false), // paid gate off — never resolves an entitlement here
                entitlements,
                orders,
                memberships,
                reliability);
    }

    // ------------------------------------------------------------- downgrade BLOCKS a GOING landing

    @Test
    void downgradedUserCannotRsvpToAGoingSpotOnACapacityLimitedEvent() {
        User user = user(DOWNGRADED_STRIKES);
        Event event = capacityLimitedEvent(5);
        stubCommon(user, event, /*going*/ 0, /*waitlisted*/ 0, /*existing*/ Optional.empty());

        assertThatThrownBy(() -> serviceWith(true).rsvp(caller, EVENT_ID))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRsvpService.RELIABILITY_DOWNGRADED);

        verify(attendance, never()).save(any());
    }

    @Test
    void downgradedUserCannotClaimAFreedSpotOnACapacityLimitedEvent() {
        User user = user(DOWNGRADED_STRIKES);
        Event event = capacityLimitedEvent(1);
        // On the waitlist, a spot has freed (going 0 < capacity 1) — a healthy member would promote here.
        stubCommon(user, event, /*going*/ 0, /*waitlisted*/ 1,
                Optional.of(new EventAttendance(EVENT_ID, USER_ID, AttendanceState.WAITLISTED)));

        assertThatThrownBy(() -> serviceWith(true).claim(caller, EVENT_ID))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRsvpService.RELIABILITY_DOWNGRADED);

        verify(publisher, never()).publishEvent(any());
    }

    // ------------------------------------------------------------- but the waitlist / unlimited stay open

    @Test
    void downgradedUserCanStillJoinTheWaitlistOfAFullCapacityLimitedEvent() {
        User user = user(DOWNGRADED_STRIKES);
        Event event = capacityLimitedEvent(1);
        stubCommon(user, event, /*going*/ 1, /*waitlisted*/ 0, Optional.empty()); // full → lands WAITLISTED

        RsvpResult result = serviceWith(true).rsvp(caller, EVENT_ID);

        assertThat(result.state()).isEqualTo(AttendanceState.WAITLISTED);
        assertThat(savedState()).isEqualTo(AttendanceState.WAITLISTED);
    }

    @Test
    void downgradedUserCanJoinAnEventWithNoCapacityLimit() {
        User user = user(DOWNGRADED_STRIKES);
        Event event = unlimitedEvent();
        stubCommon(user, event, /*going*/ 3, /*waitlisted*/ 0, Optional.empty());

        RsvpResult result = serviceWith(true).rsvp(caller, EVENT_ID);

        assertThat(result.state()).isEqualTo(AttendanceState.GOING);
        assertThat(savedState()).isEqualTo(AttendanceState.GOING);
    }

    // ------------------------------------------------------------- below threshold / feature off = unaffected

    @Test
    void anAccountBelowTheDowngradeThresholdRsvpsToAGoingSpotNormally() {
        User user = user(DOWNGRADED_STRIKES - 1); // WARNED, not DOWNGRADED
        Event event = capacityLimitedEvent(5);
        stubCommon(user, event, /*going*/ 0, /*waitlisted*/ 0, Optional.empty());

        RsvpResult result = serviceWith(true).rsvp(caller, EVENT_ID);

        assertThat(result.state()).isEqualTo(AttendanceState.GOING);
        assertThat(savedState()).isEqualTo(AttendanceState.GOING);
    }

    @Test
    void withReliabilityDisabledEvenAHighStrikeCountRsvpsToAGoingSpot() {
        User user = user(DOWNGRADED_STRIKES + 5);
        Event event = capacityLimitedEvent(5);
        stubCommon(user, event, /*going*/ 0, /*waitlisted*/ 0, Optional.empty());

        RsvpResult result = serviceWith(false).rsvp(caller, EVENT_ID); // feature OFF → gate inert

        assertThat(result.state()).isEqualTo(AttendanceState.GOING);
        assertThat(savedState()).isEqualTo(AttendanceState.GOING);
    }

    // ------------------------------------------------------------------ fixtures

    /** Stub the reads every RSVP/claim shares: provisioned user, locked visible event, counts, existing row. */
    private void stubCommon(
            User user, Event event, long going, long waitlisted, Optional<EventAttendance> existing) {
        when(users.provision(caller)).thenReturn(user);
        when(events.findByIdForUpdate(EVENT_ID)).thenReturn(Optional.of(event));
        when(bookingCutoff.isPastCutoff(any(), any())).thenReturn(false);
        when(attendance.countByEventIdAndState(EVENT_ID, AttendanceState.GOING)).thenReturn(going);
        when(attendance.countByEventIdAndState(EVENT_ID, AttendanceState.WAITLISTED)).thenReturn(waitlisted);
        when(attendance.findByEventIdAndUserId(EVENT_ID, USER_ID)).thenReturn(existing);
        // GOING-landing guard (TM-413): no other active GOING event blocks these callers.
        when(phasePolicy.openEndedStartFloor(any())).thenReturn(Instant.now());
        when(events.findActiveGoingForUser(anyLong(), anyLong(), any(), any(), any())).thenReturn(List.of());
    }

    /** The state the service actually persisted (proves the landing was not blocked). */
    private AttendanceState savedState() {
        ArgumentCaptor<EventAttendance> saved = ArgumentCaptor.forClass(EventAttendance.class);
        verify(attendance).save(saved.capture());
        return saved.getValue().getState();
    }

    private Event capacityLimitedEvent(int capacity) {
        Event event = futureEvent();
        event.setCapacity(capacity);
        return event;
    }

    private Event unlimitedEvent() {
        return futureEvent(); // capacity left null → hasCapacityLimit() == false
    }

    /** A visible, PUBLISHED event starting comfortably in the future (not started, well before cutoff). */
    private Event futureEvent() {
        Instant now = Instant.now();
        return new Event(
                "Heading",
                "Body",
                "Marhaba Cafe",
                "Europe/London",
                now.plus(Duration.ofDays(2)),
                now.minus(Duration.ofDays(1)),
                now.plus(Duration.ofDays(30)),
                CREATOR,
                now);
    }

    /** A caller account with {@code strikes} late cancellations already on record. */
    private User user(int strikes) {
        User u = new User("uid-caller", "caller@example.com", "Caller");
        setField(u, "id", USER_ID);
        setField(u, "lateCancelCount", strikes);
        return u;
    }

    private static void setField(Object target, String name, Object value) {
        try {
            var field = User.class.getDeclaredField(name);
            field.setAccessible(true);
            field.set(target, value);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }
}
