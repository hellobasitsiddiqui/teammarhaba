package com.teammarhaba.backend.event;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;

/**
 * One user's attendance on one event (TM-391): {@code GOING} holds a capacity slot,
 * {@code WAITLISTED} queues FIFO for one.
 *
 * <p>Schema is owned by Flyway ({@code V11__create_events}); Hibernate runs validate-only, so this
 * mapping must match the table exactly. The DB enforces {@code UNIQUE (event_id, user_id)} — one
 * row per user per event; a duplicate join surfaces as a {@code DataIntegrityViolationException}
 * for the join API to map. Leaving deletes the row outright (no soft-delete here), so a rejoin
 * re-inserts cleanly at the back of the queue.
 *
 * <p><b>Queue position</b> — {@code createdAt} is DB-authoritative ({@code DEFAULT now()}, mapped
 * read-only), so a caller can never claim an earlier waitlist slot than their insert. Promotion
 * ({@link #promote()}) flips the state but keeps the row — and therefore its original
 * {@code createdAt} — intact.
 *
 * <p><b>People</b> — {@code userId}/{@code eventId} are plain FK ids, not JPA associations (same
 * convention as {@code DeviceToken}), keeping this child decoupled from the parents'
 * {@code @SQLRestriction}s. Accounts are only ever soft-deleted in-app, so attendance rows survive
 * an account tombstone; readers must resolve people through {@code UserRepository} (which hides
 * tombstoned accounts) — never through this table.
 */
@Entity
@Table(name = "event_attendance")
public class EventAttendance {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "event_id", nullable = false, updatable = false)
    private Long eventId;

    @Column(name = "user_id", nullable = false, updatable = false)
    private Long userId;

    @Enumerated(EnumType.STRING)
    @Column(name = "state", nullable = false)
    private AttendanceState state;

    /** DB-authoritative join instant ({@code DEFAULT now()}) — the FIFO queue position. */
    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private Instant createdAt;

    /** Required by JPA. */
    protected EventAttendance() {
    }

    public EventAttendance(Long eventId, Long userId, AttendanceState state) {
        this.eventId = eventId;
        this.userId = userId;
        this.state = state;
    }

    public Long getId() {
        return id;
    }

    public Long getEventId() {
        return eventId;
    }

    public Long getUserId() {
        return userId;
    }

    public AttendanceState getState() {
        return state;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    /**
     * Move a waitlisted attendee into a freed {@code GOING} slot (idempotent). The row — and its
     * original {@code createdAt} — is kept, so queue history stays truthful.
     */
    public void promote() {
        this.state = AttendanceState.GOING;
    }
}
