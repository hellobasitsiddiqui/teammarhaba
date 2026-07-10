package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.EventRsvpService;
import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import org.junit.jupiter.api.Test;

/**
 * Pure-Mockito coverage of the {@link CheckoutService} branch that cannot be produced end to end (TM-477):
 * the reserved {@link EntitlementDecision#UPGRADE} verdict. No current entitlement rule yields
 * {@code UPGRADE} (the 2026-07-10 product decision turned the old Monthly-on-premium gate into a
 * {@code PAY}, see TM-476), so it is unreachable over HTTP — but checkout must still map it to a 403 via
 * {@link UpgradeRequiredException} and neither write an order nor RSVP. Every other branch is exercised by
 * {@code CheckoutIntegrationTest} against a real Postgres.
 */
class CheckoutServiceTest {

    @Test
    void upgradeDecisionThrows403AndRecordsNothing() {
        UserService users = mock(UserService.class);
        EntitlementService entitlements = mock(EntitlementService.class);
        EventRsvpService rsvps = mock(EventRsvpService.class);
        MembershipService memberships = mock(MembershipService.class);
        OrderRepository orders = mock(OrderRepository.class);
        PaymentProvider payments = mock(PaymentProvider.class);

        User user = mock(User.class);
        when(user.getId()).thenReturn(42L);
        when(users.provision(any())).thenReturn(user);
        // Force the reserved UPGRADE verdict the live resolver never returns.
        when(entitlements.resolve(any(), anyLong()))
                .thenReturn(new Entitlement(EntitlementDecision.UPGRADE, 0, EntitlementReason.PAY_PREMIUM));

        CheckoutService checkout = new CheckoutService(entitlements, rsvps, memberships, orders, users, payments);
        VerifiedUser caller = new VerifiedUser("uid-upgrade", "upgrade@example.com");

        assertThatThrownBy(() -> checkout.checkout(caller, 7L))
                .isInstanceOf(UpgradeRequiredException.class)
                .hasMessage(CheckoutService.UPGRADE_TO_ATTEND);

        // The UPGRADE path is a hard gate: no order is recorded, no RSVP, and no payment order created.
        verifyNoInteractions(orders, rsvps, payments);
    }
}
