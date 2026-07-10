package com.teammarhaba.backend.membership;

import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The renewal heartbeat (TM-620): the scheduler drives every due subscription through
 * {@link SubscriptionRenewalService#processOne} from OUTSIDE the service (so the per-row
 * {@code @Transactional} proxy fires), and neither a poisoned row nor a failed scan can escape the
 * tick — a throw is logged and the schedule survives.
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
}
