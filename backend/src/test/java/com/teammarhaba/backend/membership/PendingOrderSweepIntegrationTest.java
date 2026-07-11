package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.verify;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/**
 * The abandoned-PENDING-order TTL sweep (TM-634) end to end over a real Postgres, proving the half a mocked
 * repository can't: the derived scan query {@code findByStatusAndCreatedAtBeforeOrderByIdAsc} really filters
 * on {@code status = PENDING AND created_at < cutoff}. An order that has sat {@code PENDING} past the TTL is
 * expired (its provider order voided best-effort); a FRESH PENDING order and a settled {@code CONFIRMED}
 * order are both left untouched.
 *
 * <p>{@code created_at} is DB-authoritative ({@code DEFAULT now()}, not writable through the entity), so the
 * "old" order is aged by backdating that column via JDBC — the only way to simulate an order that has
 * genuinely outlived the window. The TTL is the shipped 30-minute default (the {@code test} profile does not
 * override {@code app.payments.pending-ttl}). Only the payment gateway seam is mocked.
 */
class PendingOrderSweepIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private PendingOrderSweepService sweep;

    @Autowired
    private UserRepository users;

    @Autowired
    private EventRepository events;

    @Autowired
    private OrderRepository orders;

    @Autowired
    private JdbcTemplate jdbc;

    @MockitoBean
    private PaymentProvider paymentProvider;

    @Test
    void expiresAnOldPendingOrderAndLeavesFreshAndSettledOnesUntouched() {
        Long buyerId = users.save(new User("uid-tm634-" + UUID.randomUUID(), "tm634@example.com", "Buyer"))
                .getId();
        Long eventId = seedEvent().getId();
        Instant now = Instant.now();

        // (1) An order that has sat PENDING past the 30m TTL — the abandoned checkout to expire.
        Long oldPendingId = savePendingOrder(buyerId, eventId, "rev-ord-old");
        jdbc.update("update orders set created_at = ? where id = ?", java.sql.Timestamp.from(now.minus(1, ChronoUnit.HOURS)), oldPendingId);

        // (2) A FRESH PENDING order (created just now) — inside the window, must NOT be swept.
        Long freshPendingId = savePendingOrder(buyerId, seedEvent().getId(), "rev-ord-fresh");

        // (3) A settled CONFIRMED order aged past the TTL too — excluded by STATUS, not age.
        Order confirmed = new Order(buyerId, seedEvent().getId(), 500, OrderStatus.CONFIRMED, now);
        confirmed.setPaymentReference("revolut", "rev-ord-confirmed");
        Long confirmedId = orders.save(confirmed).getId();
        jdbc.update("update orders set created_at = ? where id = ?", java.sql.Timestamp.from(now.minus(2, ChronoUnit.HOURS)), confirmedId);

        // The scan returns ONLY the old PENDING order.
        List<Long> stale = sweep.findExpiredPendingOrderIds(now);
        assertThat(stale).containsExactly(oldPendingId);

        // Expiring it voids the provider order best-effort and moves it to EXPIRED…
        assertThat(sweep.expireOrder(oldPendingId, now)).isTrue();
        verify(paymentProvider).cancelOrder("rev-ord-old");
        assertThat(orders.findById(oldPendingId).orElseThrow().getStatus()).isEqualTo(OrderStatus.EXPIRED);

        // …while the fresh PENDING and the settled CONFIRMED orders are untouched.
        assertThat(orders.findById(freshPendingId).orElseThrow().getStatus()).isEqualTo(OrderStatus.PENDING);
        assertThat(orders.findById(confirmedId).orElseThrow().getStatus()).isEqualTo(OrderStatus.CONFIRMED);
    }

    private Long savePendingOrder(Long buyerId, Long eventId, String providerOrderId) {
        Order order = new Order(buyerId, eventId, 500, OrderStatus.PENDING, Instant.now());
        order.setPaymentReference("revolut", providerOrderId);
        return orders.save(order).getId();
    }

    /** A minimal persisted event for the order's {@code event_id} FK ({@code UNIQUE (user_id, event_id)}). */
    private Event seedEvent() {
        Instant now = Instant.now();
        Long creatorId = users.save(
                        new User("uid-tm634-creator-" + UUID.randomUUID(), "tm634-creator@example.com", "Creator"))
                .getId();
        return events.save(new Event(
                "TM-634 sweep " + UUID.randomUUID(),
                "Abandoned-checkout fixture",
                "Marhaba Cafe",
                "Europe/London",
                now.plus(2, ChronoUnit.DAYS),
                now.minus(1, ChronoUnit.HOURS),
                now.plus(7, ChronoUnit.DAYS),
                creatorId,
                now));
    }
}
