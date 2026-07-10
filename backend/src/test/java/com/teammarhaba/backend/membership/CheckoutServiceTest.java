package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.config.MembershipProperties;
import com.teammarhaba.backend.event.CancelResult;
import com.teammarhaba.backend.event.EventRsvpService;
import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.payments.PaymentProviderException;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import com.teammarhaba.backend.web.ConflictException;
import jakarta.persistence.EntityManager;
import java.time.Instant;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.access.AccessDeniedException;

/**
 * Pure-Mockito coverage of the {@link CheckoutService} branches that cannot (or should not) be
 * produced end to end:
 *
 * <ul>
 *   <li>the reserved {@link EntitlementDecision#UPGRADE} verdict (no live rule yields it, TM-477);</li>
 *   <li>the server-side membership flag gating the PAY branch (TM-623) — the money path must be a
 *       403 while the feature is off, provably without touching the provider;</li>
 *   <li>the refund execution paths (TM-623): a settle-time RSVP guard failure marks the paid order
 *       {@code REFUND_DUE} and issues the provider refund instead of 500-looping the webhook, and an
 *       in-window cancel of a paid order actually returns the money;</li>
 *   <li>voiding the provider order when a still-PENDING PAY order is cancelled (TM-623), so the
 *       orphaned widget token can no longer capture unreconcilable money.</li>
 * </ul>
 *
 * <p>Every other branch is exercised by {@code CheckoutIntegrationTest} against a real Postgres.
 */
class CheckoutServiceTest {

    private static final VerifiedUser CALLER = new VerifiedUser("uid-42", "buyer@example.com");

    private UserService users;
    private EntitlementService entitlements;
    private EventRsvpService rsvps;
    private MembershipService memberships;
    private OrderRepository orders;
    private PaymentProvider payments;
    private EntityManager entityManager;
    private User user;

    @BeforeEach
    void setUp() {
        users = mock(UserService.class);
        entitlements = mock(EntitlementService.class);
        rsvps = mock(EventRsvpService.class);
        memberships = mock(MembershipService.class);
        orders = mock(OrderRepository.class);
        payments = mock(PaymentProvider.class);
        entityManager = mock(EntityManager.class); // refresh() is a no-op in these unit tests

        user = mock(User.class);
        when(user.getId()).thenReturn(42L);
        when(users.provision(any())).thenReturn(user);
        when(users.getById(42L)).thenReturn(user);
        // The tombstone-safe settle-time read (TM-625): the default buyer is a live account.
        when(users.findAnyById(42L)).thenReturn(Optional.of(user));
        when(payments.name()).thenReturn("revolut");
        when(orders.save(any(Order.class))).thenAnswer(inv -> inv.getArgument(0));
    }

    private CheckoutService service(boolean membershipEnabled) {
        return new CheckoutService(
                entitlements,
                rsvps,
                memberships,
                orders,
                users,
                payments,
                new MembershipProperties(membershipEnabled),
                entityManager);
    }

    @Test
    void upgradeDecisionThrows403AndRecordsNothing() {
        // Force the reserved UPGRADE verdict the live resolver never returns.
        when(entitlements.resolve(any(), anyLong()))
                .thenReturn(new Entitlement(EntitlementDecision.UPGRADE, 0, EntitlementReason.PAY_PREMIUM));

        assertThatThrownBy(() -> service(true).checkout(CALLER, 7L))
                .isInstanceOf(UpgradeRequiredException.class)
                .hasMessage(CheckoutService.UPGRADE_TO_ATTEND);

        // The UPGRADE path is a hard gate: no order is recorded, no RSVP, and no payment order created.
        verifyNoInteractions(orders, rsvps, payments);
    }

    // ------------------------------------------------------------------ server-side flag (TM-623)

    @Test
    void payBranchIs403WhileTheServerSideMembershipFlagIsOff() {
        // A PAY entitlement with the feature off: the web flag only hid the button — this gate makes
        // the endpoint itself refuse before ANY provider order (or local PENDING order) exists.
        when(entitlements.resolve(any(), anyLong()))
                .thenReturn(new Entitlement(EntitlementDecision.PAY, 500, EntitlementReason.PAY_PREMIUM));
        when(orders.findByUserIdAndEventId(42L, 7L)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service(false).checkout(CALLER, 7L))
                .isInstanceOf(AccessDeniedException.class)
                .hasMessage(CheckoutService.PAYMENTS_OFF);

        verifyNoInteractions(payments);
        verify(orders, never()).save(any());
    }

    // ------------------------------------------------------------------ settle-time guard failure (TM-623)

    @Test
    void settleTimeGuardFailureMarksRefundDueAndIssuesTheRefund() {
        // Money captured, then the RSVP guard refuses (event started while the widget was open). The
        // old behaviour rolled the confirm back — order stuck PENDING forever, webhook 500-retry loop,
        // captured money with no reversal. Now: REFUND_DUE + provider refund + a clean acknowledge.
        Order order = new Order(42L, 7L, 500, OrderStatus.PENDING, Instant.now());
        order.setPaymentReference("revolut", "rev-ord-1");
        when(orders.findByProviderOrderId("rev-ord-1")).thenReturn(Optional.of(order));
        doThrow(new ConflictException("This event has already started."))
                .when(rsvps)
                .rsvpForConfirmedOrder(user, 7L);

        service(true).confirmPayment("rev-ord-1"); // must NOT throw — the webhook is acknowledged

        verify(payments).refund("rev-ord-1", 500, "GBP", String.valueOf(order.getId()));
        assertThat(order.getStatus()).isEqualTo(OrderStatus.REFUNDED);
    }

    @Test
    void settleTimeGuardFailureKeepsRefundDueWhenTheRefundItselfFails() {
        // The refund call failing must not lose the debt: the order stays REFUND_DUE for retry.
        Order order = new Order(42L, 7L, 500, OrderStatus.PENDING, Instant.now());
        order.setPaymentReference("revolut", "rev-ord-2");
        when(orders.findByProviderOrderId("rev-ord-2")).thenReturn(Optional.of(order));
        doThrow(new ConflictException("Booking has closed.")).when(rsvps).rsvpForConfirmedOrder(user, 7L);
        doThrow(new PaymentProviderException("gateway down"))
                .when(payments)
                .refund(any(), anyInt(), any(), any());

        service(true).confirmPayment("rev-ord-2");

        assertThat(order.getStatus()).isEqualTo(OrderStatus.REFUND_DUE);
    }

    // ------------------------------------------------------------------ soft-deleted buyer at settle (TM-625)

    @Test
    void settleForASoftDeletedBuyerMarksRefundDueInsteadOfCrashingTheWebhook() {
        // The buyer soft-deleted their account while the payment widget was open; the money captured
        // anyway. The old restricted getById threw OUTSIDE any handling — the confirm rolled back,
        // the order stayed PENDING and the webhook 500-looped forever with the money kept. Now: the
        // service is undeliverable (no account to attend with), so the money is owed back — REFUND_DUE
        // + provider refund + a clean acknowledge.
        Order order = new Order(42L, 7L, 500, OrderStatus.PENDING, Instant.now());
        order.setPaymentReference("revolut", "rev-ord-6");
        when(orders.findByProviderOrderId("rev-ord-6")).thenReturn(Optional.of(order));
        User deleted = mock(User.class);
        when(deleted.isDeleted()).thenReturn(true);
        when(users.findAnyById(42L)).thenReturn(Optional.of(deleted));

        boolean matched = service(true).confirmPayment("rev-ord-6"); // must NOT throw

        assertThat(matched).isTrue();
        verify(payments).refund("rev-ord-6", 500, "GBP", String.valueOf(order.getId()));
        assertThat(order.getStatus()).isEqualTo(OrderStatus.REFUNDED);
        verifyNoInteractions(rsvps); // no attendance is ever provisioned for a tombstoned account
    }

    // ------------------------------------------------------------------ cancel-vs-void race (TM-625)

    @Test
    void settleForALocallyCancelledOrderIsFlaggedRefundDueNotSilentlyKept() {
        // The race the in-window cancel acknowledges: the best-effort void of the PENDING provider
        // order was refused because the widget payment was completing concurrently — the order is
        // CANCELLED locally, and the settle webhook then proves the money WAS captured. The old
        // confirmPaid no-op silently kept it. Now the settle is recognised as captured money for a
        // dead commitment: REFUND_DUE + provider refund.
        Order order = new Order(42L, 7L, 500, OrderStatus.PENDING, Instant.now());
        order.setPaymentReference("revolut", "rev-ord-7");
        order.reverse(Instant.now()); // the in-window cancel already ran: PENDING -> CANCELLED
        assertThat(order.getStatus()).isEqualTo(OrderStatus.CANCELLED);
        when(orders.findByProviderOrderId("rev-ord-7")).thenReturn(Optional.of(order));

        boolean matched = service(true).confirmPayment("rev-ord-7");

        assertThat(matched).isTrue();
        verify(payments).refund("rev-ord-7", 500, "GBP", String.valueOf(order.getId()));
        assertThat(order.getStatus()).isEqualTo(OrderStatus.REFUNDED);
        verifyNoInteractions(rsvps); // the cancelled commitment is never resurrected
    }

    @Test
    void repeatSettleForAConfirmedOrderStaysAPlainNoOp() {
        // The CANCELLED-settle handling must not widen: a repeat webhook for an already-CONFIRMED
        // order still does nothing — no refund, no second RSVP.
        Order order = new Order(42L, 7L, 500, OrderStatus.CONFIRMED, Instant.now());
        order.setPaymentReference("revolut", "rev-ord-8");
        when(orders.findByProviderOrderId("rev-ord-8")).thenReturn(Optional.of(order));

        boolean matched = service(true).confirmPayment("rev-ord-8");

        assertThat(matched).isTrue();
        assertThat(order.getStatus()).isEqualTo(OrderStatus.CONFIRMED);
        verify(payments, never()).refund(any(), anyInt(), any(), any());
        verifyNoInteractions(rsvps);
    }

    // ------------------------------------------------------------------ cancel: void + refund (TM-623)

    @Test
    void cancellingAPendingPayOrderVoidsTheProviderOrder() {
        // The still-payable provider order behind a cancelled PENDING order is voided best-effort, so
        // a widget left open in another tab can no longer capture money that would reconcile to nothing.
        Order order = new Order(42L, 7L, 500, OrderStatus.PENDING, Instant.now());
        order.setPaymentReference("revolut", "rev-ord-3");
        when(rsvps.cancelRsvp(any(), eq(7L), eq(false))).thenReturn(CancelResult.free(false, 0));
        when(orders.findByUserIdAndEventId(42L, 7L)).thenReturn(Optional.of(order));
        Membership membership = new Membership(42L, Instant.now());
        when(memberships.getOrEnrol(any())).thenReturn(membership);

        service(true).cancel(CALLER, 7L);

        verify(payments).cancelOrder("rev-ord-3");
        assertThat(order.getStatus()).isEqualTo(OrderStatus.CANCELLED); // no money captured — no refund
        verify(payments, never()).refund(any(), anyInt(), any(), any());
    }

    @Test
    void cancellingAPaidOrderIssuesTheRefund() {
        // In-window cancel of a CONFIRMED paid order: REFUND_DUE is no longer a dead-end — the provider
        // refund is issued in the same flow and the order lands REFUNDED.
        Order order = new Order(42L, 7L, 500, OrderStatus.CONFIRMED, Instant.now());
        order.setPaymentReference("revolut", "rev-ord-4");
        when(rsvps.cancelRsvp(any(), eq(7L), eq(false))).thenReturn(CancelResult.free(false, 0));
        when(orders.findByUserIdAndEventId(42L, 7L)).thenReturn(Optional.of(order));
        Membership membership = new Membership(42L, Instant.now());
        when(memberships.getOrEnrol(any())).thenReturn(membership);

        service(true).cancel(CALLER, 7L);

        verify(payments).refund("rev-ord-4", 500, "GBP", String.valueOf(order.getId()));
        assertThat(order.getStatus()).isEqualTo(OrderStatus.REFUNDED);
    }

    @Test
    void aFailedRefundLeavesTheOrderRefundDue() {
        Order order = new Order(42L, 7L, 500, OrderStatus.CONFIRMED, Instant.now());
        order.setPaymentReference("revolut", "rev-ord-5");
        when(rsvps.cancelRsvp(any(), eq(7L), eq(false))).thenReturn(CancelResult.free(false, 0));
        when(orders.findByUserIdAndEventId(42L, 7L)).thenReturn(Optional.of(order));
        Membership membership = new Membership(42L, Instant.now());
        when(memberships.getOrEnrol(any())).thenReturn(membership);
        doThrow(new PaymentProviderException("gateway down"))
                .when(payments)
                .refund(any(), anyInt(), any(), any());

        service(true).cancel(CALLER, 7L); // must not throw — the cancel bookkeeping stands

        assertThat(order.getStatus()).isEqualTo(OrderStatus.REFUND_DUE); // the debt stays visible
    }
}
