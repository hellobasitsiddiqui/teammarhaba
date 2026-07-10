package com.teammarhaba.backend.membership;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * The renewal heartbeat (TM-620): the scheduler drives every due subscription through
 * {@link SubscriptionRenewalService#processOne} from OUTSIDE the service (so the per-row
 * {@code @Transactional} proxy fires), and neither a poisoned row nor a failed scan can escape the
 * tick — a throw is logged and the schedule survives.
 *
 * <p>Kill switch (TM-623): the bean is OPT-IN — it exists only when BOTH
 * {@code app.subscriptions.enabled} AND {@code app.membership.enabled} are explicitly {@code true}
 * ({@code matchIfMissing = false}). The context-runner tests below prove every other combination
 * (including entirely unset — the old on-by-default trap) produces NO scheduler, so no off-session
 * charge can ever fire from a context that didn't opt in.
 */
class SubscriptionRenewalSchedulerTest {

    @Test
    void tickProcessesEveryDueSubscription() {
        SubscriptionRenewalService renewals = mock(SubscriptionRenewalService.class);
        when(renewals.findDueSubscriptionIds()).thenReturn(List.of(1L, 2L, 3L));
        when(renewals.processOne(anyLong())).thenReturn(true);

        new SubscriptionRenewalScheduler(renewals).tick();

        verify(renewals).processOne(1L);
        verify(renewals).processOne(2L);
        verify(renewals).processOne(3L);
    }

    @Test
    void aPoisonedRowDoesNotStallTheRestOfThePass() {
        SubscriptionRenewalService renewals = mock(SubscriptionRenewalService.class);
        when(renewals.findDueSubscriptionIds()).thenReturn(List.of(1L, 2L));
        when(renewals.processOne(1L)).thenThrow(new RuntimeException("optimistic lock loser"));
        when(renewals.processOne(2L)).thenReturn(true);

        new SubscriptionRenewalScheduler(renewals).tick(); // must not throw

        verify(renewals).processOne(2L); // the second row is still processed
    }

    @Test
    void aFailedScanIsSwallowed() {
        SubscriptionRenewalService renewals = mock(SubscriptionRenewalService.class);
        when(renewals.findDueSubscriptionIds()).thenThrow(new RuntimeException("db hiccup"));

        new SubscriptionRenewalScheduler(renewals).tick(); // must not throw — retried next interval
    }

    // ------------------------------------------------------------------ opt-in kill switch (TM-623)

    /** A minimal context carrying just the scheduler's bean definition + a mocked service dependency. */
    private ApplicationContextRunner contextRunner() {
        return new ApplicationContextRunner()
                .withBean(SubscriptionRenewalService.class, () -> mock(SubscriptionRenewalService.class))
                .withUserConfiguration(SubscriptionRenewalScheduler.class);
    }

    @Test
    void schedulerBootsOnlyWhenBothFlagsAreExplicitlyTrue() {
        contextRunner()
                .withPropertyValues("app.subscriptions.enabled=true", "app.membership.enabled=true")
                .run(ctx -> assertThat(ctx).hasSingleBean(SubscriptionRenewalScheduler.class));
    }

    @Test
    void schedulerIsAbsentWhenNothingIsConfigured() {
        // The old matchIfMissing=true booted the charging scheduler on-by-default in EVERY context
        // that didn't explicitly opt out. Off-session card charging must be opt-in.
        contextRunner().run(ctx -> assertThat(ctx).doesNotHaveBean(SubscriptionRenewalScheduler.class));
    }

    @Test
    void schedulerIsAbsentWithoutTheMembershipFlag() {
        // SUBSCRIPTIONS_ENABLED alone is not enough: the server-side membership feature flag is the
        // coupled kill switch — rolling the feature back turns the charging engine off with it.
        contextRunner()
                .withPropertyValues("app.subscriptions.enabled=true")
                .run(ctx -> assertThat(ctx).doesNotHaveBean(SubscriptionRenewalScheduler.class));
        contextRunner()
                .withPropertyValues("app.subscriptions.enabled=true", "app.membership.enabled=false")
                .run(ctx -> assertThat(ctx).doesNotHaveBean(SubscriptionRenewalScheduler.class));
    }

    @Test
    void schedulerIsAbsentWithoutItsOwnFlag() {
        contextRunner()
                .withPropertyValues("app.membership.enabled=true")
                .run(ctx -> assertThat(ctx).doesNotHaveBean(SubscriptionRenewalScheduler.class));
        contextRunner()
                .withPropertyValues("app.subscriptions.enabled=false", "app.membership.enabled=true")
                .run(ctx -> assertThat(ctx).doesNotHaveBean(SubscriptionRenewalScheduler.class));
    }
}
