package com.teammarhaba.backend.membership;

import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import java.time.Instant;
import java.util.Map;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Membership lifecycle for the verified caller (TM-474 / epic Membership).
 *
 * <p>Every account has exactly one membership, <strong>enrolled just-in-time</strong> like the account
 * itself (TM-112/TM-597): the first {@code GET /api/v1/me/membership} (or a tier switch) that finds no
 * row inserts one on {@link MembershipTier#PAY_PER_EVENT}; later requests reuse it. The account row is
 * resolved (and itself provisioned on first sight) through {@link UserService#provision}, so membership
 * enrolment composes cleanly with account provisioning on a brand-new user's very first call.
 *
 * <p><strong>Read-only-transaction-safe.</strong> {@code GET /me/membership} runs read-only, so the
 * first-sight INSERT must not fail with "cannot execute INSERT in a read-only transaction" and a
 * first-request burst must not double-insert. Both are handled exactly as account provisioning is
 * (TM-597): the write is delegated to {@link MembershipProvisioner} — a separate bean whose
 * {@code REQUIRES_NEW} advice actually fires (a self-invocation would skip the proxy) — which runs it in
 * a fresh <em>writable</em> transaction; a losing unique-{@code user_id} race rolls back only that inner
 * transaction and we re-read the winner's row.
 *
 * <p><strong>Self-serve tier switch, no payment gate (this slice).</strong> {@link #switchTier} lets the
 * caller move between tiers freely and records a {@link AuditAction#MEMBERSHIP_TIER_CHANGED} audit row on
 * an actual change. The paid-upgrade payment gate (Revolut) comes later (TM-478); the free-event credit
 * <em>ledger</em> and its consume/reverse (TM-477) build on the {@code firstEventCreditUsed} flag.
 */
@Service
public class MembershipService {

    /** Audit {@code target_type} for membership events. */
    private static final String TARGET_MEMBERSHIP = "Membership";

    private final MembershipRepository memberships;
    private final UserService users;
    private final MembershipProvisioner provisioner;
    private final AuditService audit;

    public MembershipService(
            MembershipRepository memberships,
            UserService users,
            MembershipProvisioner provisioner,
            AuditService audit) {
        this.memberships = memberships;
        this.users = users;
        this.provisioner = provisioner;
        this.audit = audit;
    }

    /**
     * The caller's membership, enrolling it (and the account, if new) on first sight (TM-474). Safe to
     * call from a read-only transaction and under a concurrent first-request burst (TM-597): the common
     * path is a plain read, and only a first-sight miss falls through to {@link #enrol}, which does the
     * INSERT in its own writable {@code REQUIRES_NEW} transaction and re-reads the result into this one.
     */
    @Transactional
    public Membership getOrEnrol(VerifiedUser caller) {
        User user = users.provision(caller);
        return memberships.findByUserId(user.getId()).orElseGet(() -> enrol(user.getId()));
    }

    /**
     * Self-switch the caller's membership to {@code tier} (TM-474). Enrols first if needed, so a switch
     * before any {@code GET /me/membership} still works. No payment gate in this slice (paid upgrades are
     * TM-478). Idempotent: switching to the tier already held is a no-op — the row is untouched and
     * nothing is audited. Only an actual change bumps {@code updatedAt} and records a
     * {@link AuditAction#MEMBERSHIP_TIER_CHANGED} audit row carrying the {@code from → to} transition.
     */
    @Transactional
    public Membership switchTier(VerifiedUser caller, MembershipTier tier) {
        User user = users.provision(caller);
        Membership membership =
                memberships.findByUserId(user.getId()).orElseGet(() -> enrol(user.getId()));

        MembershipTier previous = membership.getTier();
        if (previous != tier) {
            membership.changeTier(tier, Instant.now()); // dirty-checking flushes on commit
            audit.record(
                    caller.uid(),
                    AuditAction.MEMBERSHIP_TIER_CHANGED,
                    TARGET_MEMBERSHIP,
                    String.valueOf(user.getId()),
                    Map.of("from", previous.name(), "to", tier.name()));
        }
        return membership;
    }

    /**
     * No membership row: enrol it, then re-read into this transaction (TM-597). The write is delegated
     * to {@link MembershipProvisioner#createIfAbsent} (a separate bean so {@code REQUIRES_NEW} actually
     * fires), which runs it in a fresh writable transaction — so enrolment works even when this caller's
     * transaction is read-only. A losing first-request race throws {@link DataIntegrityViolationException}
     * (unique {@code user_id}); we swallow it and re-read the winner's committed row, so both callers
     * return the same single membership and neither errors. The re-read also re-attaches the row to this
     * transaction's persistence context, keeping the returned entity managed for a subsequent tier change.
     */
    private Membership enrol(Long userId) {
        try {
            provisioner.createIfAbsent(userId);
        } catch (DataIntegrityViolationException race) {
            // A concurrent first request won the unique-user_id insert; its REQUIRES_NEW transaction
            // committed the row and rolled back ours cleanly. Fall through and re-read it.
        }
        return memberships
                .findByUserId(userId)
                .orElseThrow(() -> new IllegalStateException(
                        "enrol: membership row still absent after create for user " + userId));
    }
}
