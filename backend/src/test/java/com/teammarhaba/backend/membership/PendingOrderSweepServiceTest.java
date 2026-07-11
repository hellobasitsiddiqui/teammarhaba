package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.config.PaymentsProperties;
import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.payments.PaymentProviderException;
import com.teammarhaba.backend.user.UserService;
import jakarta.persistence.EntityManager;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.data.domain.Pageable;

/**
 * The abandoned-PENDING-order TTL sweep (TM-634) with NO live payment calls. The residual it closes: before
 * this, a PAY order whose settle/decline webhook never arrived sat {@code PENDING} FOREVER — no RSVP, no
 * cleanup, and a still-live single-use widget token able to capture money nothing local would reconcile.
 * These tests prove the sweep computes the TTL cut-off, voids the provider order best-effort, and moves the
 * order {@code PENDING → EXPIRED} — while leaving anything a racing path already resolved untouched.
 *
 * <p>The "leaves fresh/settled orders untouched" half — that the derived scan query actually filters on
 * {@code created_at < cutoff} + {@code status = PENDING} — is proven against a real Postgres in
 * {@code PendingOrderSweepIntegrationTest} (a mocked repository can't verify the query itself).
 */
class PendingOrderSweepServiceTest {

    private OrderRepository orders;
    private UserService users;
    private PaymentProvider payments;
    private EntityManager entityManager;
    private PendingOrderSweepService service;

    @BeforeEach
    void setUp() {
        orders = mock(OrderRepository.class);
        users = mock(UserService.class);
        payments = mock(PaymentProvider.class);
        entityManager = mock(EntityManager.class); // refresh() is a no-op in these unit tests
        service = new PendingOrderSweepService(
                orders, users, payments, entityManager, new PaymentsProperties(Duration.ofMinutes(30)));
    }

    /** A PAY order still PENDING, carrying its provider order id (the widget token behind it). */
    private Order pendingOrder(String providerOrderId, Long id) {
        Order order = new Order(42L, 7L, 500, OrderStatus.PENDING, Instant.now());
        order.setPaymentReference("revolut", providerOrderId);
        when(orders.findById(id)).thenReturn(Optional.of(order));
        return order;
    }

    // ------------------------------------------------------------------ the scan applies the TTL cut-off

    @Test
    void scanRequestsPendingOrdersOlderThanTheConfiguredTtl() {
        Instant now = Instant.parse("2026-07-11T12:00:00Z");
        when(orders.findByStatusAndCreatedAtBeforeOrderByIdAsc(any(), any(), any()))
                .thenReturn(List.of());

        service.findExpiredPendingOrderIds(now);

        ArgumentCaptor<Instant> cutoff = ArgumentCaptor.forClass(Instant.class);
        verify(orders)
                .findByStatusAndCreatedAtBeforeOrderByIdAsc(eq(OrderStatus.PENDING), cutoff.capture(), any(Pageable.class));
        // 30-minute TTL → the cut-off is exactly now - 30m; only orders created BEFORE it are swept.
        assertThat(cutoff.getValue()).isEqualTo(now.minus(Duration.ofMinutes(30)));
    }

    // ------------------------------------------------------------------ expiry voids + transitions

    @Test
    void expireOrderVoidsTheProviderOrderAndMovesItToExpired() {
        Order order = pendingOrder("rev-ord-1", 11L);

        boolean expired = service.expireOrder(11L, Instant.now());

        assertThat(expired).isTrue();
        assertThat(order.getStatus()).isEqualTo(OrderStatus.EXPIRED);
        verify(payments).cancelOrder("rev-ord-1"); // best-effort void of the still-live widget token
        verify(users).lockForUpdate(42L); // serialised with webhook confirm/fail + user cancel on this buyer
    }

    @Test
    void expireOrderStillExpiresWhenTheBestEffortVoidIsRefused() {
        // The void can be refused (the order is mid-payment / already completed). That must NOT stop the
        // local expiry — the order is still retired, and a late settle is caught by confirmPayment's
        // settle-after-terminal race handling (REFUND_DUE + refund).
        Order order = pendingOrder("rev-ord-2", 12L);
        doThrow(new PaymentProviderException("order not cancellable"))
                .when(payments)
                .cancelOrder("rev-ord-2");

        boolean expired = service.expireOrder(12L, Instant.now()); // must not throw

        assertThat(expired).isTrue();
        assertThat(order.getStatus()).isEqualTo(OrderStatus.EXPIRED);
    }

    @Test
    void expireOrderIsANoOpForANoLongerPendingOrder() {
        // Settled/cancelled/failed between the scan and here — the re-check leaves it untouched, no void.
        Order order = new Order(42L, 7L, 500, OrderStatus.CONFIRMED, Instant.now());
        order.setPaymentReference("revolut", "rev-ord-3");
        when(orders.findById(13L)).thenReturn(Optional.of(order));

        boolean expired = service.expireOrder(13L, Instant.now());

        assertThat(expired).isFalse();
        assertThat(order.getStatus()).isEqualTo(OrderStatus.CONFIRMED);
        verify(payments, never()).cancelOrder(any());
    }

    @Test
    void expireOrderIsANoOpWhenARacingPathResolvesItUnderTheLock() {
        // A webhook confirm committed while we waited for the lock: the refresh loads the CONFIRMED row,
        // and the post-lock status re-check makes the sweep a no-op (no void, no EXPIRED overwrite).
        Order order = pendingOrder("rev-ord-4", 14L);
        doAnswer(inv -> {
                    order.confirmPaid(Instant.now()); // the winner committed: PENDING -> CONFIRMED
                    return null;
                })
                .when(entityManager)
                .refresh(order);

        boolean expired = service.expireOrder(14L, Instant.now());

        assertThat(expired).isFalse();
        assertThat(order.getStatus()).isEqualTo(OrderStatus.CONFIRMED);
        verify(payments, never()).cancelOrder(any());
    }
}
