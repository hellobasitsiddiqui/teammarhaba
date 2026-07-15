package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.membership.CheckoutService;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.BadRequestException;
import jakarta.persistence.EntityManager;
import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.test.util.ReflectionTestUtils;

/**
 * The £0-premium admin-input guard on {@link EventAdminService} (TM-726). The residual it closes: admin
 * event create/update accepted the contradictory combination premium=true + price £0, and
 * {@link EntitlementResolver} then resolved it to {@code PAY 0}, driving a zero-amount Revolut order the
 * gateway rejects. {@code requireConsistentPricing} now rejects it at the edge on the merged state (a
 * 400), so the combination never reaches the money path.
 *
 * <p>Framework-free (Mockito only, no container): the guard throws BEFORE any repository save, so the
 * create path reaches it with just the provision mock stubbed. The resolver-side defensive behaviour (a
 * legacy £0-premium row resolving to FREE, not PAY-0) is covered directly in {@code EntitlementResolverTest}.
 */
class EventAdminPricingGuardTest {

    private static final VerifiedUser ADMIN = new VerifiedUser("admin-uid", "admin@example.com");

    private EventRepository events;
    private UserService users;
    private EventAdminService service;

    @BeforeEach
    void setUp() {
        events = mock(EventRepository.class);
        EventAttendanceRepository attendance = mock(EventAttendanceRepository.class);
        VenueRepository venues = mock(VenueRepository.class);
        users = mock(UserService.class);
        AuditService audit = mock(AuditService.class);
        ApplicationEventPublisher lifecycle = mock(ApplicationEventPublisher.class);
        EntityManager entityManager = mock(EntityManager.class);
        EventPhasePolicy phase = mock(EventPhasePolicy.class);
        CheckoutService checkout = mock(CheckoutService.class);
        service = new EventAdminService(
                events, attendance, venues, users, audit, lifecycle, entityManager, phase, checkout);

        User creator = mock(User.class);
        when(creator.getId()).thenReturn(7L);
        when(users.provision(any())).thenReturn(creator);
    }

    /**
     * Stub the persistence tail so a create that PASSES the guard can run to completion: the save echoes
     * the entity and the DB-assigned id is simulated (the real create audits + publishes a lifecycle event
     * keyed on the id, which the entity carries only after persistence). Only needed by the positive
     * controls — the rejection test throws before any of this.
     */
    private void stubPersistenceAssignsId() {
        when(events.saveAndFlush(any())).thenAnswer(inv -> {
            Event saved = inv.getArgument(0);
            ReflectionTestUtils.setField(saved, "id", 99L);
            return saved;
        });
    }

    /** A valid, consistent-window draft parameterised on the price/premium under test. */
    private EventDraft draft(Integer pricePence, Boolean premium) {
        Instant now = Instant.now();
        Instant startAt = now.plus(Duration.ofHours(2));
        return new EventDraft(
                "Guarded event",
                "Description",
                "Marhaba Cafe",
                null, // mapUrl
                null, // onlineUrl
                null, // city
                null, // venueId
                "Europe/London",
                startAt,
                null, // endAt
                now.minus(Duration.ofDays(1)), // visibilityStart
                startAt.plus(Duration.ofDays(7)), // visibilityEnd
                null, // capacity
                null, // imagePath
                null, // locationRevealHours
                null, // bookingCutoffHours
                null, // cancellationWindowHours
                null, // ageMin
                null, // ageMax
                pricePence,
                premium,
                null); // openingMessage
    }

    @Test
    void createRejectsAPremiumEventPricedAtZero() {
        assertThatThrownBy(() -> service.create(ADMIN, draft(0, true)))
                .isInstanceOf(BadRequestException.class)
                .hasMessageContaining("premium");
        // Rejected before persistence — no event row written for the contradictory combination.
        verify(events, never()).saveAndFlush(any());
    }

    @Test
    void createAllowsAFreeStandardEvent() {
        // A £0 STANDARD event is a genuinely free event — allowed; the guard only fires on premium.
        stubPersistenceAssignsId();
        assertThatCode(() -> service.create(ADMIN, draft(0, false))).doesNotThrowAnyException();
    }

    @Test
    void createAllowsAPremiumEventPricedAboveZero() {
        stubPersistenceAssignsId();
        Event created = service.create(ADMIN, draft(1500, true));
        assertThat(created.isPremium()).isTrue();
        assertThat(created.getPricePence()).isEqualTo(1500);
    }
}
