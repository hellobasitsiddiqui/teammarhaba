package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.config.ReliabilityProperties;
import com.teammarhaba.backend.user.User;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Captor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * The reliability write path (TM-409) — {@link ReliabilityService#recordLateCancel} bumping the strike
 * counter and appending one append-only ledger row through the existing audit log. The policy is real
 * (shipped defaults: penalty 10, warn @1, downgrade @3); the audit sink is mocked so the ledger row's
 * shape can be asserted precisely.
 */
@ExtendWith(MockitoExtension.class)
class ReliabilityServiceTest {

    @Mock private AuditService audit;

    @Captor private ArgumentCaptor<Map<String, Object>> metadata;

    private ReliabilityService service;

    @BeforeEach
    void setUp() {
        // Built here (not as a field initializer) so the @Mock audit is injected before it is wired in.
        service = new ReliabilityService(
                new ReliabilityPolicy(new ReliabilityProperties(null, null, null, null)), audit);
    }

    @Test
    void recordLateCancelIncrementsStrikeAndAppendsSignedLedgerRow() {
        User user = new User("uid-77", "u@example.com", "U");

        int newCount = service.recordLateCancel(user, 42L);

        assertThat(newCount).isEqualTo(1);
        assertThat(user.getLateCancelCount()).as("strike persisted on the entity").isEqualTo(1);

        // One immutable ledger row, targeting the account, carrying the signed delta + reason + context.
        verify(audit).record(
                eq("uid-77"),
                eq(AuditAction.RELIABILITY_PENALTY),
                eq("User"),
                eq("uid-77"),
                metadata.capture());
        assertThat(metadata.getValue())
                .containsEntry("delta", -10) // signed debit of the configured penalty points
                .containsEntry("reason", ReliabilityService.REASON_LATE_CANCEL)
                .containsEntry("eventId", 42L)
                .containsEntry("strikeCount", 1)
                .containsEntry("status", ReliabilityStatus.WARNED.name()); // 1 strike hits the default warn @1
    }

    @Test
    void secondStrikeReportsTheRunningCount() {
        User user = new User("uid-9", "u@example.com", "U");
        service.recordLateCancel(user, 1L);

        int newCount = service.recordLateCancel(user, 2L);

        assertThat(newCount).isEqualTo(2);
        assertThat(user.getLateCancelCount()).isEqualTo(2);
    }

    @Test
    void readAccessorsDelegateToThePolicy() {
        assertThat(service.penaltyPoints()).isEqualTo(ReliabilityProperties.DEFAULT_PENALTY_POINTS);
        assertThat(service.statusFor(0)).isEqualTo(ReliabilityStatus.OK);
        assertThat(service.statusFor(ReliabilityProperties.DEFAULT_DOWNGRADE_THRESHOLD))
                .isEqualTo(ReliabilityStatus.DOWNGRADED);
        assertThat(service.isDowngraded(ReliabilityProperties.DEFAULT_DOWNGRADE_THRESHOLD)).isTrue();
    }
}
