package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * The abandoned-PENDING-order sweep heartbeat (TM-634): the scheduler drives every stale PENDING order
 * through {@link PendingOrderSweepService} from OUTSIDE the service (so the per-row {@code @Transactional}
 * proxy fires), and neither a poisoned row nor a failed scan can escape the tick.
 *
 * <p>Kill switch: the bean is OPT-IN on {@code app.membership.enabled} ALONE ({@code matchIfMissing = false})
 * — exactly like {@link RefundSweepScheduler}. The PENDING orders it retires are produced only by the
 * membership-gated PAY checkout branch, so the gate must match that producer; and it moves money (a
 * best-effort provider void), so it stays strictly opt-in.
 */
class PendingOrderSweepSchedulerTest {

    @Test
    void tickExpiresEveryStaleOrder() {
        PendingOrderSweepService sweep = mock(PendingOrderSweepService.class);
        when(sweep.findExpiredPendingOrderIds(any())).thenReturn(List.of(1L, 2L));

        new PendingOrderSweepScheduler(sweep).tick();

        verify(sweep).expireOrder(eq(1L), any());
        verify(sweep).expireOrder(eq(2L), any());
    }

    @Test
    void aPoisonedRowDoesNotStallTheRestOfThePass() {
        PendingOrderSweepService sweep = mock(PendingOrderSweepService.class);
        when(sweep.findExpiredPendingOrderIds(any())).thenReturn(List.of(1L, 2L));
        when(sweep.expireOrder(eq(1L), any())).thenThrow(new RuntimeException("optimistic lock loser"));

        new PendingOrderSweepScheduler(sweep).tick(); // must not throw

        verify(sweep).expireOrder(eq(2L), any()); // the rest of the pass survives
    }

    @Test
    void aFailedScanIsSwallowed() {
        PendingOrderSweepService sweep = mock(PendingOrderSweepService.class);
        when(sweep.findExpiredPendingOrderIds(any())).thenThrow(new RuntimeException("db hiccup"));

        new PendingOrderSweepScheduler(sweep).tick(); // must not throw — retried next interval
    }

    // ------------------------------------------------------------------ opt-in kill switch

    private ApplicationContextRunner contextRunner() {
        return new ApplicationContextRunner()
                .withBean(PendingOrderSweepService.class, () -> mock(PendingOrderSweepService.class))
                .withUserConfiguration(PendingOrderSweepScheduler.class);
    }

    @Test
    void sweeperBootsWhenMembershipIsOn() {
        contextRunner()
                .withPropertyValues("app.membership.enabled=true")
                .run(ctx -> assertThat(ctx).hasSingleBean(PendingOrderSweepScheduler.class));
    }

    @Test
    void sweeperBootsWhenMembershipIsOnAndSubscriptionsIsOff() {
        // THE LAUNCH CONFIG: MEMBERSHIP_ENABLED=true / SUBSCRIPTIONS_ENABLED=false. The PAY checkout that
        // produces PENDING orders is membership-gated, so the sweeper must exist here too.
        contextRunner()
                .withPropertyValues("app.membership.enabled=true", "app.subscriptions.enabled=false")
                .run(ctx -> assertThat(ctx).hasSingleBean(PendingOrderSweepScheduler.class));
    }

    @Test
    void sweeperIsAbsentWhenMembershipIsOff() {
        // Membership off ⇒ no PAY checkout ⇒ no PENDING producer ⇒ no sweeper (matchIfMissing=false).
        contextRunner()
                .withPropertyValues("app.membership.enabled=false")
                .run(ctx -> assertThat(ctx).doesNotHaveBean(PendingOrderSweepScheduler.class));
    }

    @Test
    void sweeperIsAbsentWhenNothingIsConfigured() {
        contextRunner().run(ctx -> assertThat(ctx).doesNotHaveBean(PendingOrderSweepScheduler.class));
    }
}
