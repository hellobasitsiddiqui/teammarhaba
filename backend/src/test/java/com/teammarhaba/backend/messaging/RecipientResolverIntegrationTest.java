package com.teammarhaba.backend.messaging;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.event.AttendanceState;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventAttendance;
import com.teammarhaba.backend.event.EventAttendanceRepository;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * {@link RecipientResolver} and its query paths against a real Postgres (Testcontainers) — the parts
 * an H2/mock could never prove: the case-insensitive/trimmed city match, the multi-event {@code GOING}
 * union resolving through {@code UserRepository}, that soft-deleted accounts genuinely drop out via the
 * {@code User} entity's {@code @SQLRestriction} (even though their attendance rows survive the
 * tombstone), and the snapshot-at-resolve-time guarantee (TM-440).
 */
class RecipientResolverIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private RecipientResolver resolver;

    @Autowired
    private UserRepository users;

    @Autowired
    private EventRepository events;

    @Autowired
    private EventAttendanceRepository attendance;

    @Autowired
    private JdbcTemplate jdbc;

    private Long newUser(String uid, String city) {
        User u = new User(uid, uid + "@example.com", uid);
        u.setCity(city);
        return users.save(u).getId();
    }

    private Long newUser(String uid) {
        return newUser(uid, null);
    }

    private Long newEvent(String heading) {
        Instant now = Instant.now();
        return events.save(new Event(
                        heading,
                        "A friendly meetup.",
                        "Marhaba Cafe, 12 High St",
                        "Europe/London",
                        now.plus(Duration.ofDays(7)),
                        now.minus(Duration.ofHours(1)),
                        now.plus(Duration.ofDays(30)),
                        newUser(heading + "-creator"),
                        now))
                .getId();
    }

    /** Soft-delete (tombstone) an account the way the app does — a native update, not a hard DELETE. */
    private void softDelete(Long userId) {
        jdbc.update("update users set deleted_at = now() where id = ?", userId);
    }

    // --- query paths -----------------------------------------------------------------------------

    @Test
    void cityQueryMatchesCaseInsensitivelyAndTrimmedExcludingSoftDeleted() {
        Long exact = newUser("city-exact", "London");
        Long otherCase = newUser("city-case", "london");
        Long padded = newUser("city-padded", "  London  ");
        Long elsewhere = newUser("city-elsewhere", "Leeds");
        Long tombstoned = newUser("city-deleted", "London");
        softDelete(tombstoned);

        List<Long> londoners = users.findActiveIdsByCity("LONDON");

        assertThat(londoners).contains(exact, otherCase, padded);
        assertThat(londoners).doesNotContain(elsewhere, tombstoned);
    }

    @Test
    void idValidationQueryReturnsOnlyActiveSubset() {
        Long active = newUser("id-active");
        Long tombstoned = newUser("id-deleted");
        softDelete(tombstoned);

        List<Long> resolved = users.findActiveIdsByIdIn(List.of(active, tombstoned, 999_999_999L));

        assertThat(resolved).containsExactly(active);
    }

    @Test
    void goingUserIdsUnionAcrossEventsAreDistinctAndGoingOnly() {
        Long eventA = newEvent("going-a");
        Long eventB = newEvent("going-b");
        Long alice = newUser("going-alice");
        Long bob = newUser("going-bob");
        Long carol = newUser("going-carol");
        Long dave = newUser("going-dave");

        attendance.save(new EventAttendance(eventA, alice, AttendanceState.GOING));
        attendance.save(new EventAttendance(eventA, bob, AttendanceState.GOING));
        attendance.save(new EventAttendance(eventA, carol, AttendanceState.WAITLISTED)); // not GOING
        attendance.save(new EventAttendance(eventB, bob, AttendanceState.GOING)); // shared across events
        attendance.save(new EventAttendance(eventB, dave, AttendanceState.GOING));

        List<Long> going = attendance.findGoingUserIds(List.of(eventA, eventB));

        assertThat(going).containsExactlyInAnyOrder(alice, bob, dave); // bob once, carol excluded
    }

    // --- resolver end-to-end ---------------------------------------------------------------------

    @Test
    void resolvesASingleActiveUserAndDropsASoftDeletedOne() {
        Long active = newUser("single-active");
        Long tombstoned = newUser("single-deleted");
        softDelete(tombstoned);

        assertThat(resolver.resolve(AudienceSpec.user(active))).containsExactly(active);
        assertThat(resolver.resolve(AudienceSpec.user(tombstoned))).isEmpty();
    }

    @Test
    void resolvesACityAudienceActiveOnly() {
        Long a = newUser("res-city-a", "Bristol");
        Long b = newUser("res-city-b", "bristol");
        Long deleted = newUser("res-city-deleted", "Bristol");
        softDelete(deleted);

        assertThat(resolver.resolve(AudienceSpec.city("Bristol")))
                .containsExactlyInAnyOrder(a, b)
                .doesNotContain(deleted);
    }

    @Test
    void resolvesEventAttendeesExcludingSoftDeletedAttendees() {
        Long event = newEvent("res-event");
        Long alice = newUser("res-event-alice");
        Long bob = newUser("res-event-bob");
        attendance.save(new EventAttendance(event, alice, AttendanceState.GOING));
        attendance.save(new EventAttendance(event, bob, AttendanceState.GOING));

        // Bob's account is tombstoned AFTER joining — his attendance row survives, but he must NOT
        // resolve as a recipient (people resolve through the User aggregate, never the attendance table).
        softDelete(bob);

        assertThat(resolver.resolve(AudienceSpec.event(event))).containsExactly(alice);
    }

    @Test
    void resolvesTheMultiEventUnionDeduped() {
        Long eventA = newEvent("union-a");
        Long eventB = newEvent("union-b");
        Long alice = newUser("union-alice");
        Long bob = newUser("union-bob");
        Long dave = newUser("union-dave");
        attendance.save(new EventAttendance(eventA, alice, AttendanceState.GOING));
        attendance.save(new EventAttendance(eventA, bob, AttendanceState.GOING));
        attendance.save(new EventAttendance(eventB, bob, AttendanceState.GOING)); // in both events
        attendance.save(new EventAttendance(eventB, dave, AttendanceState.GOING));

        assertThat(resolver.resolve(AudienceSpec.events(List.of(eventA, eventB))))
                .containsExactlyInAnyOrder(alice, bob, dave); // bob appears once
    }

    @Test
    void combinedSpecUnionsEveryDimensionOnceAndInAscendingOrder() {
        Long event = newEvent("combined-event");
        Long alice = newUser("combined-alice", "Cardiff"); // picked by id, by city, AND as attendee
        Long bob = newUser("combined-bob", "Cardiff"); // by city only
        Long carol = newUser("combined-carol"); // by attendee only
        attendance.save(new EventAttendance(event, alice, AttendanceState.GOING));
        attendance.save(new EventAttendance(event, carol, AttendanceState.GOING));

        Set<Long> recipients =
                resolver.resolve(new AudienceSpec(Set.of(alice), Set.of("Cardiff"), Set.of(event)));

        // Each recipient appears once (no double-count) AND in deterministic ascending id order.
        List<Long> ascending = new ArrayList<>(List.of(alice, bob, carol));
        Collections.sort(ascending);
        assertThat(recipients).containsExactlyElementsOf(ascending);
    }

    @Test
    void resolutionIsASnapshotSoLaterJoinersAreNotRetroAdded() {
        Long event = newEvent("snapshot-event");
        Long alice = newUser("snapshot-alice");
        Long bob = newUser("snapshot-bob");
        attendance.save(new EventAttendance(event, alice, AttendanceState.GOING));

        // Resolve now — the snapshot captures only alice.
        Set<Long> snapshot = resolver.resolve(AudienceSpec.event(event));
        assertThat(snapshot).containsExactly(alice);

        // Bob joins AFTER the snapshot was taken.
        attendance.save(new EventAttendance(event, bob, AttendanceState.GOING));

        // The already-resolved snapshot is a materialised set — bob is not retro-added to it...
        assertThat(snapshot).containsExactly(alice);
        // ...but a fresh resolve reflects current membership.
        assertThat(resolver.resolve(AudienceSpec.event(event))).containsExactlyInAnyOrder(alice, bob);
    }

    @Test
    void emptySpecResolvesToNobody() {
        assertThat(resolver.resolve(new AudienceSpec(null, null, null))).isEmpty();
    }
}
