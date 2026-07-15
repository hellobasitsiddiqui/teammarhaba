package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.membership.Order;
import com.teammarhaba.backend.membership.OrderRepository;
import com.teammarhaba.backend.membership.OrderStatus;
import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/**
 * Admin-cancel refund fan-out end to end against a real Postgres (TM-740). The money-safety regression the
 * TM-655 re-review found: admin-cancelling a PAID event flipped the event to {@code CANCELLED} but reversed
 * NO money — no order was looked up, no {@code REFUND_DUE} was set, the {@link PaymentProvider} refund was
 * never called — and because a cancelled event then reads as "not found", attendees could not even
 * self-serve their own refund. Captured money was stranded per paid attendee.
 *
 * <p>These cases pin the fix: an admin cancel now drives every money-bearing {@code CONFIRMED} order on the
 * event to {@code REFUND_DUE} and issues the provider refund (reusing the existing checkout refund
 * machinery), while leaving £0 orders untouched and staying a no-op for a free event with no paid orders.
 * The {@link PaymentProvider} is mocked so no live Revolut call is made; the refund <em>invocation</em> is
 * what proves the previously-missing money reversal now runs.
 */
class EventAdminCancelRefundIntegrationTest extends AbstractIntegrationTest {

    private static final int PREMIUM_PRICE = 1500; // £15 captured charge behind a paid CONFIRMED order

    @Autowired
    private EventAdminService admin;

    @Autowired
    private EventRepository events;

    @Autowired
    private UserRepository users;

    @Autowired
    private OrderRepository orders;

    // Mock the provider so tryRefund's payments.refund(...) is exercised without a live Revolut call
    // (the real adapter is unit-tested in RevolutPaymentProviderTest). currency()/name() feed the refund call.
    @MockitoBean
    private PaymentProvider paymentProvider;

    @Test
    void adminCancelOfPaidEventRefundsEveryConfirmedPaidOrder() {
        when(paymentProvider.currency()).thenReturn("GBP");
        // refund(...) returns void and succeeds by default (no PaymentProviderException thrown) → REFUNDED.

        Event event = paidEvent();
        Order order = seedPaidConfirmedOrder(event.getId());
        VerifiedUser adminCaller = adminCaller();

        // Before: the order is a settled, money-bearing CONFIRMED commitment.
        assertThat(order.getStatus()).isEqualTo(OrderStatus.CONFIRMED);

        admin.cancel(adminCaller, event.getId());

        // The provider refund was issued for exactly this captured order (amount + merchant ref = order id).
        verify(paymentProvider)
                .refund(eq(order.getProviderOrderId()), eq(PREMIUM_PRICE), eq("GBP"), eq(String.valueOf(order.getId())));

        // The order is now REFUNDED (a successful inline refund is terminal) — re-read fresh from the DB, so
        // the reversal is proven persisted in the cancel transaction, not just a mutated in-memory instance.
        Order refreshed = orders.findById(order.getId()).orElseThrow();
        assertThat(refreshed.getStatus()).isEqualTo(OrderStatus.REFUNDED);
        assertThat(events.findById(event.getId()).orElseThrow().getStatus()).isEqualTo(EventStatus.CANCELLED);
    }

    @Test
    void adminCancelOfFreeEventWithNoPaidOrdersTouchesNoMoney() {
        Event event = paidEvent();
        // A £0 CONFIRMED order (FREE/INCLUDED) — attendance history, no captured money to return.
        Order free = orders.save(new Order(userId("free"), event.getId(), 0, OrderStatus.CONFIRMED, Instant.now()));
        VerifiedUser adminCaller = adminCaller();

        admin.cancel(adminCaller, event.getId());

        // No refund attempted for a £0 order, and it is left CONFIRMED (attendance history — not reversed).
        verifyNoInteractions(paymentProvider);
        assertThat(orders.findById(free.getId()).orElseThrow().getStatus()).isEqualTo(OrderStatus.CONFIRMED);
        assertThat(events.findById(event.getId()).orElseThrow().getStatus()).isEqualTo(EventStatus.CANCELLED);
    }

    // ------------------------------------------------------------------ fixtures

    /** A money-bearing CONFIRMED order with a captured provider payment, so tryRefund reaches payments.refund. */
    private Order seedPaidConfirmedOrder(Long eventId) {
        Order order = new Order(userId("paid"), eventId, PREMIUM_PRICE, OrderStatus.CONFIRMED, Instant.now());
        order.setPaymentReference("revolut", "prov-" + UUID.randomUUID());
        return orders.save(order);
    }

    private Long userId(String tag) {
        String uid = "uid-adc-" + tag + "-" + UUID.randomUUID();
        return users.save(new User(uid, uid + "@example.com", tag)).getId();
    }

    private VerifiedUser adminCaller() {
        String uid = "uid-adc-admin-" + UUID.randomUUID();
        User user = users.save(new User(uid, uid + "@example.com", "Admin"));
        return new VerifiedUser(user.getFirebaseUid(), user.getEmail());
    }

    /** A PUBLISHED, visible-now premium event starting in 2 days, priced so its orders carry real money. */
    private Event paidEvent() {
        return saveEvent(e -> {
            e.setPricePence(PREMIUM_PRICE);
            e.setPremium(true);
        });
    }

    private Event saveEvent(Consumer<Event> tweak) {
        Instant now = Instant.now();
        User creator = users.save(
                new User("uid-adc-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"));
        Event event = new Event(
                "Admin cancel refund " + UUID.randomUUID(),
                "Come along!",
                "Marhaba Cafe",
                "Europe/London",
                now.plus(2, ChronoUnit.DAYS),
                now.minus(1, ChronoUnit.HOURS),
                now.plus(7, ChronoUnit.DAYS),
                creator.getId(),
                now);
        event.setCapacity(10);
        tweak.accept(event);
        return events.save(event);
    }
}
