package com.teammarhaba.backend.membership;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;

/**
 * An account's membership (TM-474 / epic Membership). Exactly one row per account: every account is
 * JIT-enrolled onto {@link MembershipTier#PAY_PER_EVENT} on first sight (like the {@code users} row
 * itself, TM-112/TM-597), so entitlements + billing (later slices) always have a row to hang off.
 *
 * <p>Schema is owned by Flyway ({@code V35__create_membership}); Hibernate runs validate-only, so this
 * mapping must match the table exactly. Stored against {@code user_id} (the {@code users.id} surrogate
 * key) with {@code ON DELETE CASCADE} — a removed account has no membership to bill. We keep only the
 * FK id here rather than a JPA association, to stay decoupled from the {@code User} aggregate's
 * {@code @SQLRestriction} (the same convention as {@link com.teammarhaba.backend.device.DeviceToken}).
 *
 * <p>Optimistic concurrency via {@code @Version}: concurrent tier switches on the same row fail the
 * second writer with a {@code 409} (via {@code GlobalExceptionHandler}) rather than silently
 * overwriting the first — mirroring {@code users}/{@code events}.
 *
 * <p>This slice models the first-event freebie as a single {@link #firstEventCreditUsed} flag; the
 * consume-on-commitment / reverse-on-in-window-cancel logic that flips it lives in checkout (TM-477).
 */
@Entity
@Table(name = "membership")
public class Membership {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false, unique = true, updatable = false)
    private Long userId;

    /**
     * The account's current tier. Defaults to {@link MembershipTier#PAY_PER_EVENT} — Hibernate writes
     * this Java default on insert, so every JIT-enrolled account starts pay-per-event; the DB column
     * default only backstops out-of-band inserts. {@link #changeTier} is the only mutation.
     */
    @Enumerated(EnumType.STRING)
    @Column(name = "tier", nullable = false)
    private MembershipTier tier = MembershipTier.PAY_PER_EVENT;

    /**
     * Whether this account's one first-event freebie has been spent. {@code false} on enrolment (the
     * credit is available); {@code GET /me/membership} surfaces the negation ({@code
     * firstEventCreditAvailable}). The consume/reverse call that flips this lives in checkout (TM-477);
     * this slice only reads it.
     */
    @Column(name = "first_event_credit_used", nullable = false)
    private boolean firstEventCreditUsed = false;

    /**
     * Which event consumed the first-event credit (TM-477); {@code null} while the credit is available or
     * after a reversal. Recorded on commitment alongside {@link #firstEventCreditUsed} so an in-window
     * cancel of <em>exactly</em> that event can return the credit — and only that event's cancel does.
     */
    @Column(name = "first_event_credit_event_id")
    private Long firstEventCreditEventId;

    /** When the first-event credit was consumed (TM-477); {@code null} while available / after reversal. */
    @Column(name = "first_event_credit_consumed_at")
    private Instant firstEventCreditConsumedAt;

    /** DB-authoritative creation timestamp ({@code DEFAULT now()}); read-only on the entity. */
    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private Instant createdAt;

    /** App-managed: set on enrol and {@linkplain #changeTier bumped} on every tier change. */
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    /** Optimistic-lock counter; Hibernate bumps it on every update and rejects stale writes. */
    @Version
    @Column(name = "version", nullable = false)
    private long version;

    /** Required by JPA. */
    protected Membership() {
    }

    /**
     * Enrol a new account onto the default {@link MembershipTier#PAY_PER_EVENT} tier with its
     * first-event credit available. {@code now} stamps {@code updated_at}; {@code created_at} is
     * filled by the DB default.
     */
    public Membership(Long userId, Instant now) {
        this.userId = userId;
        this.updatedAt = now;
    }

    public Long getId() {
        return id;
    }

    public Long getUserId() {
        return userId;
    }

    public MembershipTier getTier() {
        return tier;
    }

    /** Whether the account's first-event freebie has been spent ({@code false} = still available). */
    public boolean isFirstEventCreditUsed() {
        return firstEventCreditUsed;
    }

    /** The event that consumed the first-event credit, or {@code null} if it is available/reversed. */
    public Long getFirstEventCreditEventId() {
        return firstEventCreditEventId;
    }

    /** When the first-event credit was consumed, or {@code null} if it is available/reversed. */
    public Instant getFirstEventCreditConsumedAt() {
        return firstEventCreditConsumedAt;
    }

    /**
     * Spend this account's one first-event credit on {@code eventId} (TM-477), recording which event
     * consumed it and when. Called by checkout on commitment, atomically with the order write, so a race
     * can never double-spend the credit. Idempotent guard is the caller's job: only invoked on a
     * {@code FIRST_EVENT_FREE} entitlement, and the {@code UNIQUE (user_id, event_id)} order constraint
     * plus the caller's user-row lock ensure a given (user, event) checkout runs its consume exactly once.
     */
    public void consumeFirstEventCredit(Long eventId, Instant when) {
        this.firstEventCreditUsed = true;
        this.firstEventCreditEventId = eventId;
        this.firstEventCreditConsumedAt = when;
        this.updatedAt = when;
    }

    /**
     * Return the first-event credit (TM-477) — the reverse of {@link #consumeFirstEventCredit}: clears the
     * used flag and the consumed-event pointer so the freebie is available again. Called by checkout when
     * the event that consumed it is cancelled inside the cancellation window.
     */
    public void reverseFirstEventCredit(Instant when) {
        this.firstEventCreditUsed = false;
        this.firstEventCreditEventId = null;
        this.firstEventCreditConsumedAt = null;
        this.updatedAt = when;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    /**
     * Switch to a new tier and bump {@code updatedAt} (TM-474). Callers only invoke this when the tier
     * actually differs (so an audit + timestamp bump only happen on a real change); the dirty entity
     * flushes on commit.
     */
    public void changeTier(MembershipTier tier, Instant when) {
        this.tier = tier;
        this.updatedAt = when;
    }
}
