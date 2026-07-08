package com.teammarhaba.backend.messaging;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.event.EventAttendanceRepository;
import com.teammarhaba.backend.user.UserRepository;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * {@link RecipientResolver} union / de-duplication / candidate-validation rules against mocked
 * repositories (TM-440). The real query paths (case-insensitive city match, the multi-event GOING
 * union, and that soft-deleted accounts actually drop out) are proven end-to-end against a real
 * Postgres in {@link RecipientResolverIntegrationTest}; here we stub the repositories and assert the
 * resolver's own logic: which query each dimension drives, that explicit-id + attendee candidates are
 * validated in one pass, and that the union is distinct and deterministically ordered.
 */
@ExtendWith(MockitoExtension.class)
class RecipientResolverTest {

    @Mock private UserRepository users;
    @Mock private EventAttendanceRepository attendance;

    private RecipientResolver resolver() {
        return new RecipientResolver(users, attendance);
    }

    @Test
    void singleUserIdIsValidatedThroughUserRepositoryAndReturnedWhenActive() {
        when(users.findActiveIdsByIdIn(any())).thenReturn(List.of(7L));

        Set<Long> recipients = resolver().resolve(AudienceSpec.user(7L));

        assertThat(recipients).containsExactly(7L);
        assertThat(candidatesPassedToUserValidation()).containsExactly(7L);
        // A user-only spec touches neither the city query nor attendance at all.
        verify(users, never()).findActiveIdsByCity(any());
        verifyNoInteractions(attendance);
    }

    @Test
    void softDeletedOrUnknownExplicitIdsAreDropped() {
        // Two ids asked for; the validation query only returns the one that maps to an active account.
        when(users.findActiveIdsByIdIn(any())).thenReturn(List.of(1L));

        Set<Long> recipients = resolver().resolve(AudienceSpec.users(List.of(1L, 2L)));

        assertThat(recipients).containsExactly(1L); // 2L was soft-deleted/unknown → silently dropped
        assertThat(candidatesPassedToUserValidation()).containsExactlyInAnyOrder(1L, 2L);
    }

    @Test
    void cityAudienceComesStraightFromTheActiveOnlyCityQuery() {
        when(users.findActiveIdsByCity("London")).thenReturn(List.of(11L, 10L));

        Set<Long> recipients = resolver().resolve(AudienceSpec.city("London"));

        assertThat(recipients).containsExactly(10L, 11L); // ascending, distinct
        // No explicit ids and no events → the id-validation query is never hit, nor attendance.
        verify(users, never()).findActiveIdsByIdIn(any());
        verifyNoInteractions(attendance);
    }

    @Test
    void eventAttendeesAreValidatedThroughUserRepository() {
        when(attendance.findGoingUserIds(any())).thenReturn(List.of(5L, 6L));
        when(users.findActiveIdsByIdIn(any())).thenReturn(List.of(5L, 6L));

        Set<Long> recipients = resolver().resolve(AudienceSpec.event(42L));

        assertThat(recipients).containsExactly(5L, 6L);
        assertThat(eventIdsPassedToAttendance()).containsExactly(42L);
        // Attendees are candidates, so they DO pass through the active-account validation query.
        assertThat(candidatesPassedToUserValidation()).containsExactlyInAnyOrder(5L, 6L);
        verify(users, never()).findActiveIdsByCity(any());
    }

    @Test
    void eventAttendeesThatAreAllSoftDeletedResolveToNobody() {
        when(attendance.findGoingUserIds(any())).thenReturn(List.of(5L));
        when(users.findActiveIdsByIdIn(any())).thenReturn(List.of()); // 5L's account was tombstoned

        Set<Long> recipients = resolver().resolve(AudienceSpec.event(9L));

        assertThat(recipients).isEmpty();
    }

    @Test
    void multiEventUnionIsResolvedInOneAttendanceQuery() {
        // The query itself unions + de-dupes across the events; the resolver just forwards the id set.
        when(attendance.findGoingUserIds(any())).thenReturn(List.of(5L, 6L, 7L));
        when(users.findActiveIdsByIdIn(any())).thenReturn(List.of(5L, 6L, 7L));

        Set<Long> recipients = resolver().resolve(AudienceSpec.events(List.of(1L, 2L)));

        assertThat(recipients).containsExactly(5L, 6L, 7L);
        assertThat(eventIdsPassedToAttendance()).containsExactlyInAnyOrder(1L, 2L);
    }

    @Test
    void combinedSpecUnionsEveryDimensionDistinctlyAndInAscendingOrder() {
        // A user picked by id (3), by their city (Leeds also lists 3 and 20), AND as an attendee
        // (event 9 has 20 and 21) must appear exactly once. 3 overlaps id↔city; 20 overlaps city↔event.
        when(users.findActiveIdsByCity("Leeds")).thenReturn(List.of(20L, 3L));
        when(attendance.findGoingUserIds(any())).thenReturn(List.of(21L, 20L));
        when(users.findActiveIdsByIdIn(any())).thenReturn(List.of(3L, 20L, 21L));

        Set<Long> recipients =
                resolver().resolve(new AudienceSpec(Set.of(3L), Set.of("Leeds"), Set.of(9L)));

        assertThat(recipients).containsExactly(3L, 20L, 21L); // distinct union, ascending
        // Candidates fed to validation = explicit ids ∪ GOING attendees (city ids are already active).
        assertThat(candidatesPassedToUserValidation()).containsExactlyInAnyOrder(3L, 20L, 21L);
    }

    @Test
    void emptySpecResolvesToNobodyWithoutTouchingAnyRepository() {
        Set<Long> recipients = resolver().resolve(new AudienceSpec(null, null, null));

        assertThat(recipients).isEmpty();
        verifyNoInteractions(users, attendance);
    }

    @Test
    void nullSpecIsRejected() {
        assertThatThrownBy(() -> resolver().resolve(null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    void resolvedSetIsUnmodifiable() {
        when(users.findActiveIdsByIdIn(any())).thenReturn(List.of(1L));

        Set<Long> recipients = resolver().resolve(AudienceSpec.user(1L));

        assertThatThrownBy(() -> recipients.add(2L)).isInstanceOf(UnsupportedOperationException.class);
    }

    @Test
    void cityMatchIsQueriedOncePerDistinctCity() {
        when(users.findActiveIdsByCity(eq("Leeds"))).thenReturn(List.of(1L));
        when(users.findActiveIdsByCity(eq("Hull"))).thenReturn(List.of(2L));

        Set<Long> recipients = resolver().resolve(AudienceSpec.cities(List.of("Leeds", "Hull")));

        assertThat(recipients).containsExactly(1L, 2L);
        verify(users).findActiveIdsByCity("Leeds");
        verify(users).findActiveIdsByCity("Hull");
    }

    /** The candidate id set the resolver handed to the active-account validation query. */
    @SuppressWarnings("unchecked")
    private Collection<Long> candidatesPassedToUserValidation() {
        ArgumentCaptor<Collection<Long>> captor = ArgumentCaptor.forClass(Collection.class);
        verify(users).findActiveIdsByIdIn(captor.capture());
        return captor.getValue();
    }

    /** The event id set the resolver handed to the GOING-attendee query. */
    @SuppressWarnings("unchecked")
    private Collection<Long> eventIdsPassedToAttendance() {
        ArgumentCaptor<Collection<Long>> captor = ArgumentCaptor.forClass(Collection.class);
        verify(attendance).findGoingUserIds(captor.capture());
        return captor.getValue();
    }
}
