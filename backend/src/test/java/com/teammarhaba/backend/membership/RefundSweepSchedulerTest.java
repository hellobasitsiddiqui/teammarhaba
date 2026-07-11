package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * The refund-sweep heartbeat (TM-625): the scheduler drives every {@code REFUND_DUE} row in BOTH
 * ledgers through {@link RefundSweepService} from OUTSIDE the service (so the per-row
 * {@code @Transactional} proxy fires), and neither a poisoned row nor a failed scan can escape the
 * tick.
 *
 * <p>Kill switch: the bean is OPT-IN on {@code app.membership.enabled} ALONE
 * ({@code matchIfMissing = false}) — TM-630. The {@code REFUND_DUE} producers it drains are the
 * membership-gated EVENT checkout/cancel refund paths ({@code CheckoutService}), which are live with
 * or without subscriptions; the original TM-625 gate additionally required
 * {@code app.subscriptions.enabled}, so the launch config (membership on, subscriptions off) had live
 * refund producers and NO sweeper — a failed inline refund stranded captured money forever. The
 * context-runner tests prove the bean exists whenever membership is explicitly on (whatever the
 * subscriptions flag says) and never otherwise.
 */
class RefundSweepSchedulerTest {

    @Test
    void tickSweepsBothLedgers() {
        RefundSweepService refunds = mock(RefundSweepService.class);
        when(refunds.findRefundDueOrderIds()).thenReturn(List.of(1L, 2L));
        when(refunds.findRefundDueChargeIds()).thenReturn(List.of(9L));

        new RefundSweepScheduler(refunds).tick();

        verify(refunds).processOrder(1L);
        verify(refunds).processOrder(2L);
        verify(refunds).processCharge(9L);
    }

    @Test
    void aPoisonedRowDoesNotStallTheRestOfThePass() {
        RefundSweepService refunds = mock(RefundSweepService.class);
        when(refunds.findRefundDueOrderIds()).thenReturn(List.of(1L, 2L));
        when(refunds.processOrder(1L)).thenThrow(new RuntimeException("optimistic lock loser"));
        when(refunds.findRefundDueChargeIds()).thenReturn(List.of(9L));

        new RefundSweepScheduler(refunds).tick(); // must not throw

        verify(refunds).processOrder(2L); // the rest of the orders pass survives
        verify(refunds).processCharge(9L); // …and so does the charge ledger's sweep
    }

    @Test
    void aFailedScanIsSwallowed() {
        RefundSweepService refunds = mock(RefundSweepService.class);
        when(refunds.findRefundDueOrderIds()).thenThrow(new RuntimeException("db hiccup"));

        new RefundSweepScheduler(refunds).tick(); // must not throw — retried next interval
    }

    // ------------------------------------------------- opt-in kill switch (TM-625, regated by TM-630)

    /** A minimal context carrying just the sweeper's bean definition + a mocked service dependency. */
    private ApplicationContextRunner contextRunner() {
        return new ApplicationContextRunner()
                .withBean(RefundSweepService.class, () -> mock(RefundSweepService.class))
                .withUserConfiguration(RefundSweepScheduler.class);
    }

    @Test
    void sweeperBootsWhenBothFlagsAreExplicitlyTrue() {
        contextRunner()
                .withPropertyValues("app.subscriptions.enabled=true", "app.membership.enabled=true")
                .run(ctx -> assertThat(ctx).hasSingleBean(RefundSweepScheduler.class));
    }

    @Test
    void sweeperBootsWhenMembershipIsOnAndSubscriptionsIsOff() {
        // THE LAUNCH CONFIG (TM-630): MEMBERSHIP_ENABLED=true / SUBSCRIPTIONS_ENABLED=false. The EVENT
        // checkout/cancel refund paths — the REFUND_DUE producers — are gated on membership ALONE, so
        // the sweeper must exist here too. The old gate (BOTH flags) meant this exact configuration had
        // live refund producers and no sweeper: one failed inline refund stranded captured customer
        // money in REFUND_DUE with no retry — the TM-625 dead-end reopened by configuration.
        contextRunner()
                .withPropertyValues("app.membership.enabled=true", "app.subscriptions.enabled=false")
                .run(ctx -> assertThat(ctx).hasSingleBean(RefundSweepScheduler.class));
    }

    @Test
    void sweeperBootsWhenMembershipIsOnAndSubscriptionsIsUnset() {
        // Same producers argument when the subscriptions property is never bound at all: membership
        // explicitly on is the whole opt-in.
        contextRunner()
                .withPropertyValues("app.membership.enabled=true")
                .run(ctx -> assertThat(ctx).hasSingleBean(RefundSweepScheduler.class));
    }

    @Test
    void sweeperIsAbsentWhenNothingIsConfigured() {
        // The money-mover rule (TM-623/TM-625): a context that never opted in gets NO bean —
        // matchIfMissing=false. It moves money (back to the customer), so it stays strictly opt-in.
        contextRunner().run(ctx -> assertThat(ctx).doesNotHaveBean(RefundSweepScheduler.class));
    }

    @Test
    void sweeperIsAbsentWhenMembershipIsOff() {
        // membership=false kills the sweeper regardless of the subscriptions flag — with membership off
        // every REFUND_DUE producer is unreachable too, so its absence strands nothing.
        contextRunner()
                .withPropertyValues("app.subscriptions.enabled=true", "app.membership.enabled=false")
                .run(ctx -> assertThat(ctx).doesNotHaveBean(RefundSweepScheduler.class));
    }
}
