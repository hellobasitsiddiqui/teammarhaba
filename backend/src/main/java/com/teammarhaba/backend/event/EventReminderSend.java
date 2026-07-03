package com.teammarhaba.backend.event;

import com.teammarhaba.backend.notify.PushNotificationService.PushFanout;
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
 * The persisted claim that one reminder — one ({@link Event}, {@link ReminderMilestone}) pair —
 * has been taken for sending (TM-394). Schema is owned by Flyway
 * ({@code V14__create_event_reminder_sends}); Hibernate runs validate-only, so this mapping must
 * match the table exactly.
 *
 * <p><b>This row is the idempotency guard, not just a log.</b> The DB-unique
 * {@code (event_id, milestone)} pair means at most one claim can ever exist per reminder: the
 * scheduler <em>inserts this row first, commits, then sends</em>, so a concurrent instance (or a
 * restarted one) that tries the same reminder hits the unique constraint and skips. That makes the
 * guard shared/cluster-wide — deliberately unlike the broadcast cooldown's process-local map (see
 * {@code BroadcastService}), because "at most one 1h reminder" must hold across every Cloud Run
 * instance, not per process. The cost of claim-before-send is at-most-once semantics: a crash
 * between claim and send drops that reminder rather than ever duplicating it.
 *
 * <p>The fan-out counts are back-filled after the send (best effort) for observability; a row left
 * all-zero is the visible trace of a claimed-but-interrupted send.
 *
 * <p>{@code eventId} is a plain FK id, not a JPA association — same convention as
 * {@link EventAttendance} — so this table stays decoupled from the {@code Event} aggregate.
 */
@Entity
@Table(name = "event_reminder_sends")
public class EventReminderSend {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "event_id", nullable = false, updatable = false)
    private Long eventId;

    @Enumerated(EnumType.STRING)
    @Column(name = "milestone", nullable = false, updatable = false)
    private ReminderMilestone milestone;

    /** DB-authoritative claim instant ({@code DEFAULT now()}); read-only on the entity. */
    @Column(name = "sent_at", nullable = false, updatable = false, insertable = false)
    private Instant sentAt;

    @Column(name = "targeted", nullable = false)
    private int targeted;

    @Column(name = "delivered", nullable = false)
    private int delivered;

    @Column(name = "pruned", nullable = false)
    private int pruned;

    @Column(name = "failed", nullable = false)
    private int failed;

    /** Required by JPA. */
    protected EventReminderSend() {
    }

    /** A fresh claim for one (event, milestone); counts start at zero until the send back-fills. */
    public EventReminderSend(Long eventId, ReminderMilestone milestone) {
        this.eventId = eventId;
        this.milestone = milestone;
    }

    /** Back-fill the fan-out outcome after the send — the row's observability payload. */
    public void recordFanout(PushFanout fanout) {
        this.targeted = fanout.targeted();
        this.delivered = fanout.delivered();
        this.pruned = fanout.pruned();
        this.failed = fanout.failed();
    }

    public Long getId() {
        return id;
    }

    public Long getEventId() {
        return eventId;
    }

    public ReminderMilestone getMilestone() {
        return milestone;
    }

    public Instant getSentAt() {
        return sentAt;
    }

    public int getTargeted() {
        return targeted;
    }

    public int getDelivered() {
        return delivered;
    }

    public int getPruned() {
        return pruned;
    }

    public int getFailed() {
        return failed;
    }
}
