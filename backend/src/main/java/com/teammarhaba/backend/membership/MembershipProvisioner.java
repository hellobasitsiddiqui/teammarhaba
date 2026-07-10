package com.teammarhaba.backend.membership;

import java.time.Instant;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * The <em>writable</em> half of just-in-time membership enrolment (TM-474), built on the exact TM-597
 * {@link com.teammarhaba.backend.user.UserProvisioner} pattern.
 *
 * <p>{@link MembershipService#getOrEnrol} is reached from a <strong>read-only</strong> surface:
 * {@code GET /api/v1/me/membership} (and, transitively, any {@code /me}-style read that enrols a
 * membership) runs under a read-only transaction. With Spring's default {@code REQUIRED} propagation, a
 * naive {@code @Transactional} enrol would simply <em>join</em> that read-only outer transaction, so a
 * first-sight INSERT blows up with "cannot execute INSERT in a read-only transaction". And a
 * first-request burst from one new user (several parallel {@code /me} calls) races: two callers both
 * see "no membership" and both INSERT, tripping the {@code membership_user_id_key} unique constraint.
 *
 * <p>This bean isolates the create in its <strong>own</strong> {@link Propagation#REQUIRES_NEW}
 * transaction. Because it is a separate Spring bean, the call from {@code MembershipService} crosses a
 * real proxy boundary (a self-invocation would silently skip the new-transaction advice), so the write
 * always runs in a fresh, <em>writable</em> transaction — regardless of a read-only caller — and
 * commits (or cleanly rolls back) independently of it.
 *
 * <p>The unique-violation race is handled where it belongs: the losing INSERT throws
 * {@link DataIntegrityViolationException}, which rolls back <em>only</em> this inner transaction (never
 * poisoning the caller's), and {@code MembershipService} then simply re-reads the winner's now-committed
 * row. Net effect: exactly one membership is ever created and every concurrent caller returns it.
 */
@Service
class MembershipProvisioner {

    private final MembershipRepository memberships;

    MembershipProvisioner(MembershipRepository memberships) {
        this.memberships = memberships;
    }

    /**
     * Enrol {@code userId} onto the default {@link MembershipTier#PAY_PER_EVENT} tier in a dedicated
     * writable transaction. Only ever invoked once {@link MembershipService#getOrEnrol} has already
     * failed to find a row, so the common (row-exists) path never pays for the extra transaction.
     *
     * <p>Runs in a brand-new transaction ({@link Propagation#REQUIRES_NEW}) so it neither inherits a
     * read-only caller transaction nor, on the unique-violation race, drags the caller's transaction
     * into rollback. Guards with a re-check ({@code findByUserId}) so a caller that already committed a
     * row between the outer read and here reuses it. The unique-{@code user_id} INSERT is what
     * serialises concurrent first requests: the winner commits here via {@code saveAndFlush} (forcing
     * the INSERT to hit the DB now), the loser gets a {@link DataIntegrityViolationException} (this
     * transaction rolls back) and {@code MembershipService} re-reads the winner's row.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Membership createIfAbsent(Long userId) {
        return memberships
                .findByUserId(userId)
                .orElseGet(() -> memberships.saveAndFlush(new Membership(userId, Instant.now())));
    }
}
