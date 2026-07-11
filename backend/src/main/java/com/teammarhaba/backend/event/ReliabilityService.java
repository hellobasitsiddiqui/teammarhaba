package com.teammarhaba.backend.event;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.user.User;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The write + read facade for the reliability-points economy (TM-409). It is the single collaborator
 * {@link EventRsvpService} talks to for reliability: it applies a late-cancellation penalty (bumping
 * the TM-414 strike counter and appending a ledger entry), and delegates standing/gate questions to
 * {@link ReliabilityPolicy}.
 *
 * <p><b>The ledger</b> (AC: append-only, auditable — reuse the audit pattern). Rather than a bespoke
 * table, each penalty is one immutable row in the existing append-only audit log
 * ({@code AuditAction.RELIABILITY_PENALTY}, {@link AuditService}) targeting the account. Its metadata
 * carries the signed points {@code delta}, the {@code reason}, the {@code eventId} the strike came
 * from, the resulting running {@code strikeCount} and the resulting {@code status}. Because the audit
 * write joins the caller's transaction, the strike, the attendance delete and the ledger row all
 * commit or roll back together — a penalty is never silently un-ledgered. The admin console reads a
 * user's ledger through the existing audit search endpoint
 * ({@code GET /api/v1/admin/audit?targetType=User&targetId=<uid>}).
 *
 * <p>Design note — the reliability signal stays <b>count-backed</b> ({@code users.late_cancel_count},
 * TM-414) so TM-409 needs no new table/column: each late cancel is one strike that debits
 * {@code penaltyPoints} in the ledger, and the account's standing is derived from the running strike
 * count against the configured thresholds. No-show penalties + on-time credit (which restore points)
 * depend on check-in (TM-405) and are out of scope here, exactly as the ticket defers them.
 */
@Service
public class ReliabilityService {

    /** Audit {@code target_type} for reliability ledger rows — mirrors the account-targeting convention. */
    private static final String TARGET_USER = "User";

    /** The ledger reason for a strike that came from leaving inside the cancellation window. */
    static final String REASON_LATE_CANCEL = "LATE_CANCEL";

    private final ReliabilityPolicy policy;
    private final AuditService audit;

    public ReliabilityService(ReliabilityPolicy policy, AuditService audit) {
        this.policy = policy;
        this.audit = audit;
    }

    /**
     * Apply a late-cancellation penalty to {@code user}, transactionally: bump the strike counter
     * (TM-414's {@link User#recordLateCancel()}) and append the matching reliability ledger row. Runs
     * in the caller's un-RSVP transaction (propagation REQUIRED), so the strike and the ledger row
     * commit atomically with the attendance delete.
     *
     * @return the account's new running strike count (post-increment) — used for the honest
     *     "this is your Nth" pre-confirm copy and for deriving the resulting standing.
     */
    @Transactional
    public int recordLateCancel(User user, Long eventId) {
        int newCount = user.recordLateCancel();
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("delta", -policy.penaltyPoints()); // signed debit — points come off on a late cancel
        metadata.put("reason", REASON_LATE_CANCEL);
        metadata.put("eventId", eventId);
        metadata.put("strikeCount", newCount);
        metadata.put("status", policy.statusFor(newCount).name());
        audit.record(user.getFirebaseUid(), AuditAction.RELIABILITY_PENALTY, TARGET_USER, user.getFirebaseUid(), metadata);
        return newCount;
    }

    /** The account's reliability standing for a given running strike count (delegates to the policy). */
    public ReliabilityStatus statusFor(int lateCancelCount) {
        return policy.statusFor(lateCancelCount);
    }

    /** Whether an account with this strike count is downgraded — the RSVP/claim gate predicate. */
    public boolean isDowngraded(int lateCancelCount) {
        return policy.isDowngraded(lateCancelCount);
    }

    /** Reliability points a single late cancellation debits — the pre-confirm "cost". */
    public int penaltyPoints() {
        return policy.penaltyPoints();
    }
}
