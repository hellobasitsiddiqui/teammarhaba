package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.payments.PaymentProviderException;
import com.teammarhaba.backend.user.UserService;
import jakarta.persistence.EntityManager;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.domain.Pageable;

/**
 * The {@code REFUND_DUE} retry sweep (TM-625) with NO live payment calls. The residual it closes: a
 * refund attempt that failed at issue time used to leave the row {@code REFUND_DUE} FOREVER — the code
 * said "for retry (admin/sweeper)" but no sweeper, admin endpoint or even repository status query
 * existed, so one transient gateway 5xx meant captured money owed back with no operation able to return
 * it. These tests prove the sweep finds such rows, re-attempts the provider refund, resolves them on
 * success, and keeps the debt visible (retried next pass) on another failure.
 */
class RefundSweepServiceTest {

    private OrderRepository orders;
    private SubscriptionChargeRepository charges;
    private UserService users;
    private PaymentProvider payments;
    private EntityManager entityManager;
    private RefundSweepService service;

    @BeforeEach
    void setUp() {
        orders = mock(OrderRepository.class);
        charges = mock(SubscriptionChargeRepository.class);
        users = mock(UserService.class);
        payments = mock(PaymentProvider.class);
        entityManager = mock(EntityManager.class); // refresh() is a no-op in these unit tests
        when(payments.currency()).thenReturn("GBP"); // the seam-exposed refund currency (TM-629)
        service = new RefundSweepService(orders, charges, users, payments, entityManager);
    }

    /** An order whose inline refund attempt already failed — sitting REFUND_DUE, the dead-end state. */
    private Order refundDueOrder() {
        Order order = new Order(42L, 7L, 500, OrderStatus.CONFIRMED, Instant.now());
        order.setPaymentReference("revolut", "rev-ord-1");
        order.markRefundDue(Instant.now());
        when(orders.findById(11L)).thenReturn(Optional.of(order));
        return order;
    }

    // ------------------------------------------------------------------ the failed refund is retried

    @Test
    void aFailedRefundIsRetriedByTheSweepAndLandsRefunded() {
        // The regression the residual demands (TM-625): the inline refund failed (gateway hiccup), the
        // order was left REFUND_DUE — the sweep must RE-ATTEMPT the provider refund and resolve it.
        Order order = refundDueOrder();

        boolean resolved = service.processOrder(11L);

        assertThat(resolved).isTrue();
        verify(payments).refund("rev-ord-1", 500, "GBP", String.valueOf(order.getId()));
        assertThat(order.getStatus()).isEqualTo(OrderStatus.REFUNDED);
        verify(users).lockForUpdate(42L); // serialised with webhook confirms / cancels on this buyer
    }

    @Test
    void aStillFailingRefundStaysRefundDueForTheNextPass() {
        // The provider is still down: the debt must stay visible — never dropped, never REFUNDED.
        Order order = refundDueOrder();
        doThrow(new PaymentProviderException("gateway down"))
                .when(payments)
                .refund(any(), anyInt(), any(), any());

        boolean resolved = service.processOrder(11L); // must not throw

        assertThat(resolved).isFalse();
        assertThat(order.getStatus()).isEqualTo(OrderStatus.REFUND_DUE); // retried next tick
        assertThat(order.getRefundAttempts()).isEqualTo(1); // one attempt burned, still under the cap
    }

    @Test
    void aPermanentlyRejectedOrderRefundIsAbandonedOnceTheRetryCapIsExhausted() {
        // The residual TM-726 closes: a refund the provider will PERMANENTLY reject (already refunded out
        // of band / too old / wrong amount) was retried FOREVER, hammering the same doomed full refund on
        // every hourly pass. Now, after MAX_REFUND_ATTEMPTS failures the row moves to the terminal
        // REFUND_ABANDONED so the sweep stops retrying and a human reconciles it.
        Order order = refundDueOrder();
        doThrow(new PaymentProviderException("order already refunded"))
                .when(payments)
                .refund(any(), anyInt(), any(), any());

        for (int i = 1; i < RefundSweepService.MAX_REFUND_ATTEMPTS; i++) {
            assertThat(service.processOrder(11L)).isFalse();
            assertThat(order.getStatus()).isEqualTo(OrderStatus.REFUND_DUE); // still retried below the cap
        }
        // The final (cap-th) attempt exhausts the budget → terminal, no longer swept.
        assertThat(service.processOrder(11L)).isFalse();
        assertThat(order.getRefundAttempts()).isEqualTo(RefundSweepService.MAX_REFUND_ATTEMPTS);
        assertThat(order.getStatus()).isEqualTo(OrderStatus.REFUND_ABANDONED);
    }

    @Test
    void anOrderResolvedByARacingPathIsANoOp() {
        // Someone else (a racing sweep instance, or a manual fix) already resolved the row — the
        // re-check under the lock makes the sweep charge-safe: no second refund call.
        Order order = new Order(42L, 7L, 500, OrderStatus.CONFIRMED, Instant.now());
        order.setPaymentReference("revolut", "rev-ord-2");
        order.markRefundDue(Instant.now());
        when(orders.findById(12L)).thenReturn(Optional.of(order));
        // Simulate "the winner committed while we waited": the refresh loads the REFUNDED row.
        doAnswer(inv -> {
                    order.markRefunded(Instant.now());
                    return null;
                })
                .when(entityManager)
                .refresh(order);

        boolean resolved = service.processOrder(12L);

        assertThat(resolved).isFalse();
        verify(payments, never()).refund(any(), anyInt(), any(), any());
    }

    // ------------------------------------------------------------------ subscription-charge ledger

    @Test
    void aRefundDueSubscriptionChargeIsSweptToo() {
        // The subscription ledger's REFUND_DUE rows (a superseded order's duplicate late settle whose
        // inline refund failed, TM-625) are swept exactly like event orders.
        SubscriptionCharge charge = new SubscriptionCharge(
                42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, Instant.now());
        charge.setPaymentReference("revolut", "rev-sub-1", "cust-1", Instant.now());
        charge.markRefundDue(Instant.now());
        when(charges.findById(21L)).thenReturn(Optional.of(charge));

        boolean resolved = service.processCharge(21L);

        assertThat(resolved).isTrue();
        verify(payments).refund("rev-sub-1", 999, "GBP", "sub-charge:" + charge.getId());
        assertThat(charge.getStatus()).isEqualTo(SubscriptionCharge.Status.REFUNDED);
    }

    @Test
    void aStillFailingChargeRefundStaysRefundDue() {
        SubscriptionCharge charge = new SubscriptionCharge(
                42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, Instant.now());
        charge.setPaymentReference("revolut", "rev-sub-2", "cust-1", Instant.now());
        charge.markRefundDue(Instant.now());
        when(charges.findById(22L)).thenReturn(Optional.of(charge));
        doThrow(new PaymentProviderException("gateway down"))
                .when(payments)
                .refund(any(), anyInt(), any(), any());

        boolean resolved = service.processCharge(22L);

        assertThat(resolved).isFalse();
        assertThat(charge.getStatus()).isEqualTo(SubscriptionCharge.Status.REFUND_DUE);
        assertThat(charge.getRefundAttempts()).isEqualTo(1);
    }

    @Test
    void aPermanentlyRejectedChargeRefundIsAbandonedOnceTheRetryCapIsExhausted() {
        // The subscription-ledger twin of the order retry-cap (TM-726): a permanently-rejected charge
        // refund is abandoned to the terminal REFUND_ABANDONED after MAX_REFUND_ATTEMPTS, not retried
        // forever.
        SubscriptionCharge charge = new SubscriptionCharge(
                42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, Instant.now());
        charge.setPaymentReference("revolut", "rev-sub-3", "cust-1", Instant.now());
        charge.markRefundDue(Instant.now());
        when(charges.findById(23L)).thenReturn(Optional.of(charge));
        doThrow(new PaymentProviderException("order already refunded"))
                .when(payments)
                .refund(any(), anyInt(), any(), any());

        for (int i = 1; i < RefundSweepService.MAX_REFUND_ATTEMPTS; i++) {
            assertThat(service.processCharge(23L)).isFalse();
            assertThat(charge.getStatus()).isEqualTo(SubscriptionCharge.Status.REFUND_DUE);
        }
        assertThat(service.processCharge(23L)).isFalse();
        assertThat(charge.getRefundAttempts()).isEqualTo(RefundSweepService.MAX_REFUND_ATTEMPTS);
        assertThat(charge.getStatus()).isEqualTo(SubscriptionCharge.Status.REFUND_ABANDONED);
    }

    // ------------------------------------------------------------------ the scans feed the sweep

    @Test
    void scansReturnTheRefundDueIdsOldestFirst() {
        Order order = new Order(42L, 7L, 500, OrderStatus.CONFIRMED, Instant.now());
        order.markRefundDue(Instant.now());
        when(orders.findByStatusOrderByIdAsc(any(OrderStatus.class), any(Pageable.class)))
                .thenReturn(List.of(order));
        SubscriptionCharge charge = new SubscriptionCharge(
                42L, SubscriptionCharge.Kind.INITIAL, MembershipTier.MONTHLY, 999, Instant.now());
        charge.markRefundDue(Instant.now());
        when(charges.findByStatusOrderByIdAsc(any(SubscriptionCharge.Status.class), any(Pageable.class)))
                .thenReturn(List.of(charge));

        assertThat(service.findRefundDueOrderIds()).hasSize(1);
        assertThat(service.findRefundDueChargeIds()).hasSize(1);
        verify(orders).findByStatusOrderByIdAsc(eq(OrderStatus.REFUND_DUE), any(Pageable.class));
        verify(charges).findByStatusOrderByIdAsc(eq(SubscriptionCharge.Status.REFUND_DUE), any(Pageable.class));
    }
}
