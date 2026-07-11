package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
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
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.context.ApplicationEventPublisher;

/**
 * The late-cancellation branch matrix on {@link EventRsvpService#cancelRsvp} (TM-414), against mocked
 * collaborators with a real {@link CancellationPolicy} (app default 24h). Asserts the ticket's rules
 * directly: a late cancel (GOING inside the window) increments the strike counter and returns the
 * honest running-count message; an early cancel — or leaving a WAITLISTED/absent slot — is free and
 * silent; {@code preview = true} reports the same verdict but writes nothing; and a cancel after the
 * event has started is still a {@code 409}. The full transactional persistence + {@code /me} exposure
 * is covered end-to-end by {@code EventLateCancellationIntegrationTest}.
 */
@ExtendWith(MockitoExtension.class)
class EventRsvpServiceCancellationTest {

    private static final long EVENT_ID = 42L;
    private static final long USER_ID = 7L;
    private static final long CREATOR = 9L;

    @Mock private EventRepository events;
    @Mock private EventAttendanceRepository attendance;
    @Mock private UserService users;
    @Mock private ApplicationEventPublisher publisher;

    /** TM-413's RSVP booking cutoff — a collaborator of the service but never exercised on the cancel path. */
    @Mock private BookingCutoffPolicy bookingCutoff;

    /** TM-415's age-group guard — a collaborator of the service but never exercised on the cancel path. */
    @Mock private AgeEligibilityPolicy ageGate;

    /** TM-404's one-active-event guard uses this for open-ended events — not exercised on the cancel path. */
    @Mock private EventPhasePolicy phasePolicy;

    /** TM-446's event-chat lifecycle — invoked on the leave (onLeave) path; a mocked no-op here. */
    @Mock private EventChatLifecycleService chatLifecycle;

    /** TM-625's paid-event join gate — a collaborator of the service but never exercised on the cancel path. */
    @Mock private EntitlementService entitlements;

    /** TM-625's settled-order exemption lookup — never exercised on the cancel path (leaving is never gated). */
    @Mock private OrderRepository orders;

    /** TM-629's credit-consume-on-commitment — only exercised on a FREE-first JOIN, never on cancel. */
    @Mock private MembershipService memberships;

    /** TM-409's reliability ledger sink — a late cancel appends one row; mocked (no-op) here. */
    @Mock private AuditService audit;

    private final VerifiedUser caller = new VerifiedUser("uid-caller", "caller@example.com");
    private final CancellationPolicy policy =
            new CancellationPolicy(new CancellationWindowProperties(24, Map.of()));

    private EventRsvpService service() {
        return new EventRsvpService(
                events,
                attendance,
                users,
                policy,
                ageGate,
                publisher,
                bookingCutoff,
                phasePolicy,
                chatLifecycle,
                // The paid gate only fires on a JOIN with the flag on — cancels never resolve an
                // entitlement, so a flag-off properties record keeps this suite entirely gate-free.
                new MembershipProperties(false),
                entitlements,
                orders,
                memberships,
                // A real reliability layer on the shipped defaults (penalty 10, warn @1, downgrade @3) so
                // the cancel path exercises the true strike + ledger + standing behaviour; only the audit
                // ledger write is mocked. Built here (not as a field) so the @Mock audit is injected first.
                new ReliabilityService(
                        new ReliabilityPolicy(new ReliabilityProperties(null, null, null, null)), audit));
    }

    // ------------------------------------------------------------------ late cancel (a strike)

    @Test
    void goingCancelInsideWindowIsLate_incrementsCounterAndMessagesTheRunningCount() {
        User user = user(0);
        stub(user, startingIn(Duration.ofHours(12)), AttendanceState.GOING); // 12h < 24h window → late

        CancelResult result = service().cancelRsvp(caller, EVENT_ID);

        assertThat(result.preview()).isFalse();
        assertThat(result.lateCancel()).isTrue();
        assertThat(result.lateCancelCount()).isEqualTo(1);
        assertThat(result.message()).contains("late cancellation").contains("your 1st");
        assertThat(user.getLateCancelCount()).as("strike persisted on the entity").isEqualTo(1);
        verify(attendance).deleteByEventIdAndUserId(EVENT_ID, USER_ID);
    }

    @Test
    void runningCountAndOrdinalReflectPriorStrikes() {
        User user = user(1); // already has one strike on record
        stub(user, startingIn(Duration.ofHours(2)), AttendanceState.GOING);

        CancelResult result = service().cancelRsvp(caller, EVENT_ID);

        assertThat(result.lateCancelCount()).isEqualTo(2);
        assertThat(result.message()).contains("your 2nd");
        assertThat(user.getLateCancelCount()).isEqualTo(2);
    }

    // ------------------------------------------------------------------ free & silent

    @Test
    void goingCancelOutsideWindowIsFreeAndSilent() {
        User user = user(0);
        stub(user, startingIn(Duration.ofHours(48)), AttendanceState.GOING); // 48h > 24h window → early

        CancelResult result = service().cancelRsvp(caller, EVENT_ID);

        assertThat(result.lateCancel()).isFalse();
        assertThat(result.lateCancelCount()).isZero();
        assertThat(result.message()).as("early cancels say nothing special").isNull();
        assertThat(user.getLateCancelCount()).isZero();
        verify(attendance).deleteByEventIdAndUserId(EVENT_ID, USER_ID);
    }

    @Test
    void leavingAWaitlistedSlotInsideWindowIsNeverAStrike() {
        // A waitlisted member surrenders no committed spot, so bailing — even last-minute — is free.
        User user = user(0);
        stub(user, startingIn(Duration.ofHours(1)), AttendanceState.WAITLISTED);

        CancelResult result = service().cancelRsvp(caller, EVENT_ID);

        assertThat(result.lateCancel()).isFalse();
        assertThat(result.message()).isNull();
        assertThat(user.getLateCancelCount()).isZero();
        verify(attendance).deleteByEventIdAndUserId(EVENT_ID, USER_ID);
    }

    @Test
    void leavingAnEventYouAreNotOnIsANoOpNoStrike() {
        User user = user(0);
        stubNotAttending(user, startingIn(Duration.ofHours(1)));

        CancelResult result = service().cancelRsvp(caller, EVENT_ID);

        assertThat(result.lateCancel()).isFalse();
        assertThat(result.message()).isNull();
        assertThat(user.getLateCancelCount()).isZero();
        verify(attendance).deleteByEventIdAndUserId(EVENT_ID, USER_ID); // idempotent delete, removes nothing
    }

    // ------------------------------------------------------------------ preview (pre-confirm)

    @Test
    void previewOfALateCancelReportsTheVerdictButWritesNothing() {
        User user = user(0);
        stub(user, startingIn(Duration.ofHours(12)), AttendanceState.GOING);

        CancelResult result = service().cancelRsvp(caller, EVENT_ID, true);

        assertThat(result.preview()).isTrue();
        assertThat(result.lateCancel()).isTrue();
        assertThat(result.lateCancelCount()).as("the count it WOULD reach").isEqualTo(1);
        assertThat(result.message()).contains("would count as a late cancellation").contains("your 1st");
        assertThat(user.getLateCancelCount()).as("nothing written on a dry-run").isZero();
        verify(attendance, never()).deleteByEventIdAndUserId(anyLong(), anyLong());
    }

    // ------------------------------------------------------------------ change window

    @Test
    void cancellingAfterTheEventHasStartedIsAConflict() {
        User user = user(0);
        when(users.provision(caller)).thenReturn(user);
        when(events.findByIdForUpdate(EVENT_ID)).thenReturn(Optional.of(startingIn(Duration.ofHours(-1))));

        assertThatThrownBy(() -> service().cancelRsvp(caller, EVENT_ID))
                .isInstanceOf(ConflictException.class)
                .hasMessage(EventRsvpService.EVENT_STARTED);

        assertThat(user.getLateCancelCount()).isZero();
        verify(attendance, never()).deleteByEventIdAndUserId(anyLong(), anyLong());
    }

    // ------------------------------------------------------------------ fixtures

    /** Wire provision → user, the locked event, and the caller's GOING/WAITLISTED attendance row. */
    private void stub(User user, Event event, AttendanceState state) {
        when(users.provision(caller)).thenReturn(user);
        when(events.findByIdForUpdate(EVENT_ID)).thenReturn(Optional.of(event));
        when(attendance.findByEventIdAndUserId(EVENT_ID, USER_ID))
                .thenReturn(Optional.of(new EventAttendance(EVENT_ID, USER_ID, state)));
    }

    /** Wire provision → user and the locked event, with the caller not on the event at all. */
    private void stubNotAttending(User user, Event event) {
        when(users.provision(caller)).thenReturn(user);
        when(events.findByIdForUpdate(EVENT_ID)).thenReturn(Optional.of(event));
        when(attendance.findByEventIdAndUserId(EVENT_ID, USER_ID)).thenReturn(Optional.empty());
    }

    /** A visible, PUBLISHED event whose start is {@code untilStart} from now (negative = already started). */
    private Event startingIn(Duration untilStart) {
        Instant now = Instant.now();
        return new Event(
                "Heading",
                "Body",
                "Marhaba Cafe",
                "Europe/London",
                now.plus(untilStart),
                now.minus(Duration.ofDays(1)),
                now.plus(Duration.ofDays(30)),
                CREATOR,
                now);
    }

    /** A caller account seeded with {@code priorStrikes} late cancellations already on record. */
    private User user(int priorStrikes) {
        User u = new User("uid-caller", "caller@example.com", "Caller");
        setField(u, "id", USER_ID);
        setField(u, "lateCancelCount", priorStrikes);
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
