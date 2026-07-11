package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/**
 * The TM-630 launch-config proof, end to end over a real Postgres: with {@code app.membership.enabled=true}
 * and {@code app.subscriptions.enabled=false} — exactly what the {@code test} profile runs, and exactly the
 * MEMBERSHIP_ENABLED=true / SUBSCRIPTIONS_ENABLED=false configuration launch flips to — a stranded EVENT
 * {@code REFUND_DUE} order IS picked up and retried by the refund sweeper.
 *
 * <p><strong>The defect this pins down.</strong> {@code REFUND_DUE} orders are produced by the EVENT
 * checkout / cancel refund paths ({@code CheckoutService}), which are gated on membership ALONE — but the
 * sweeper's original TM-625 gate additionally required {@code app.subscriptions.enabled} (copied from the
 * subscription-specific renewal scheduler). In the launch config that meant live refund producers with NO
 * sweeper bean at all: one failed inline refund stranded captured customer money in {@code REFUND_DUE}
 * with no retry — the exact dead-end TM-625 closed, reopened by configuration. Before the TM-630 regate
 * this class could not even load its context (no {@link RefundSweepScheduler} bean to autowire); with it,
 * the sweep drains the stranded row through the REAL service — per-row transaction, user-row lock,
 * {@code EntityManager.refresh} — with only the provider seam mocked.
 *
 * <p>The sweeper is live-but-dormant in every integration-test context ({@code application-test.yml}
 * pushes its first scheduled tick a day out), so this test drives {@link RefundSweepScheduler#tick()}
 * directly — same determinism convention as every other scheduler test.
 */
class RefundSweepMembershipOnlyIntegrationTest extends AbstractIntegrationTest {

    /**
     * The bean under proof: autowiring it is itself the gate assertion — before TM-630 this context had
     * no such bean in this configuration and the class failed to load.
     */
    @Autowired
    private RefundSweepScheduler sweeper;

    @Autowired
    private Environment environment;

    @Autowired
    private UserRepository users;

    @Autowired
    private EventRepository events;

    @Autowired
    private OrderRepository orders;

    // Mock ONLY the payment gateway seam (the same seam CheckoutIntegrationTest mocks): a Mockito void
    // refund() succeeds by default, standing in for the provider accepting the retried refund.
    @MockitoBean
    private PaymentProvider paymentProvider;

    /**
     * Premise guard: this class proves the LAUNCH configuration, so fail loudly if the test profile ever
     * stops being membership-on / subscriptions-off (the proof would silently change meaning otherwise).
     */
    @Test
    void testProfileRunsTheLaunchConfiguration() {
        assertThat(environment.getProperty("app.membership.enabled", Boolean.class))
                .as("test profile must run with membership ON (the launch config)")
                .isTrue();
        assertThat(environment.getProperty("app.subscriptions.enabled", Boolean.class))
                .as("test profile must run with subscriptions OFF (the launch config)")
                .isFalse();
    }

    @Test
    void aStrandedEventRefundIsSweptInTheMembershipOnlyConfiguration() {
        // A paid event order whose inline refund attempt failed at issue time: captured provider money,
        // REFUND_DUE on the books, nothing scheduled to come back for it — the stranded state.
        Long buyerId = users.save(new User("uid-tm630-" + UUID.randomUUID(), "tm630@example.com", "Buyer"))
                .getId();
        Order order = new Order(buyerId, seedEvent().getId(), 1500, OrderStatus.CONFIRMED, Instant.now());
        order.setPaymentReference("revolut", "rev-ord-tm630");
        order.markRefundDue(Instant.now());
        Long orderId = orders.save(order).getId();

        when(paymentProvider.currency()).thenReturn("GBP"); // seam-exposed charge currency (TM-629)

        // One sweeper heartbeat in the membership-only context.
        sweeper.tick();

        // The debt was picked up and RETRIED at the provider with the captured amount…
        verify(paymentProvider).refund("rev-ord-tm630", 1500, "GBP", String.valueOf(orderId));
        // …and the accepted refund resolved the row terminally: the money is no longer stranded.
        assertThat(orders.findById(orderId).orElseThrow().getStatus()).isEqualTo(OrderStatus.REFUNDED);
    }

    /** A minimal persisted event for the order's {@code event_id} FK; its state is irrelevant to the sweep. */
    private Event seedEvent() {
        Instant now = Instant.now();
        Long creatorId = users.save(
                        new User("uid-tm630-creator-" + UUID.randomUUID(), "tm630-creator@example.com", "Creator"))
                .getId();
        return events.save(new Event(
                "TM-630 sweep " + UUID.randomUUID(),
                "Stranded-refund fixture",
                "Marhaba Cafe",
                "Europe/London",
                now.plus(2, ChronoUnit.DAYS),
                now.minus(1, ChronoUnit.HOURS),
                now.plus(7, ChronoUnit.DAYS),
                creatorId,
                now));
    }
}
