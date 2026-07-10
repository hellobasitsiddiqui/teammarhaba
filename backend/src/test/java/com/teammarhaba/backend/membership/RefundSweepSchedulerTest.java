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
 * <p>Kill switch: the bean is OPT-IN on the SAME flag pair as the renewal scheduler — it exists only
 * when BOTH {@code app.subscriptions.enabled} AND {@code app.membership.enabled} are explicitly
 * {@code true} ({@code matchIfMissing = false}). The context-runner tests prove every other
 * combination (including entirely unset) produces NO sweeper.
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

    // ------------------------------------------------------------------ opt-in kill switch (TM-625)

    /** A minimal context carrying just the sweeper's bean definition + a mocked service dependency. */
    private ApplicationContextRunner contextRunner() {
        return new ApplicationContextRunner()
                .withBean(RefundSweepService.class, () -> mock(RefundSweepService.class))
                .withUserConfiguration(RefundSweepScheduler.class);
    }

    @Test
    void sweeperBootsOnlyWhenBothFlagsAreExplicitlyTrue() {
        contextRunner()
                .withPropertyValues("app.subscriptions.enabled=true", "app.membership.enabled=true")
                .run(ctx -> assertThat(ctx).hasSingleBean(RefundSweepScheduler.class));
    }

    @Test
    void sweeperIsAbsentWhenNothingIsConfigured() {
        // The money-mover rule (TM-623/TM-625): a context that never opted in gets NO bean —
        // matchIfMissing=false, exactly like the renewal scheduler it is coupled to.
        contextRunner().run(ctx -> assertThat(ctx).doesNotHaveBean(RefundSweepScheduler.class));
    }

    @Test
    void sweeperIsAbsentWhenOnlyTheSubscriptionsFlagIsOn() {
        contextRunner()
                .withPropertyValues("app.subscriptions.enabled=true", "app.membership.enabled=false")
                .run(ctx -> assertThat(ctx).doesNotHaveBean(RefundSweepScheduler.class));
    }

    @Test
    void sweeperIsAbsentWhenOnlyTheMembershipFlagIsOn() {
        contextRunner()
                .withPropertyValues("app.subscriptions.enabled=false", "app.membership.enabled=true")
                .run(ctx -> assertThat(ctx).doesNotHaveBean(RefundSweepScheduler.class));
    }
}
