package com.teammarhaba.backend.alert;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import org.hibernate.annotations.Generated;
import org.hibernate.generator.EventType;

/**
 * One site-wide alert/announcement (TM-243) — the data behind a global, scheduled, colour-coded,
 * dismissible banner that can be sent or pulled <b>without a redeploy</b>. The web app shell renders
 * these once for every surface (web + the Android WebView, which loads the same hosted build).
 *
 * <p>Schema is owned by Flyway ({@code V24__create_alerts}); Hibernate runs validate-only, so this
 * mapping must match the table exactly. {@code createdAt} is DB-authoritative ({@code default now()})
 * and read back after insert, so the history's newest-first order can't be caller-skewed.
 *
 * <p><b>The table IS the history.</b> Rows are never hard-deleted, so the admin list is the durable
 * "what was sent and when" record. A notice is never removed early by deletion — it is
 * <em>expired</em> ({@link #expireNow(Instant)} sets {@code expiresAt = now}), which pulls the live
 * banner while keeping the audit trail.
 *
 * <p><b>Mostly immutable.</b> Everything about what the alert <em>is</em> (message/level/dismissal/
 * scope/schedule/actor) is set once at construction and has no setter; the only permitted mutation is
 * expire-now, which brings {@code expiresAt} forward. The derived {@link AlertStatus} is computed, not
 * stored (see {@link #status(Instant)}).
 *
 * <p><b>Public-read safety.</b> The active read is allow-listed for unauthenticated callers so a
 * warning can show pre-login, therefore {@code message} must never carry sensitive data — it is a
 * public broadcast. {@code createdBy} (the actor uid) is deliberately <em>not</em> exposed on the
 * public shape (see {@code AlertResponse}); only the admin history reveals it.
 */
@Entity
@Table(name = "alert")
public class Alert {

    /** The only scope the MVP honours; the column exists so per-route/surface targeting is additive. */
    public static final String SCOPE_GLOBAL = "global";

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "message", nullable = false, updatable = false)
    private String message;

    @Enumerated(EnumType.STRING)
    @Column(name = "level", nullable = false, updatable = false)
    private AlertLevel level;

    @Enumerated(EnumType.STRING)
    @Column(name = "dismissal", nullable = false, updatable = false)
    private AlertDismissal dismissal;

    /** Where the alert shows. MVP only ever writes/honours {@link #SCOPE_GLOBAL}. */
    @Column(name = "scope", nullable = false, updatable = false)
    private String scope;

    @Column(name = "starts_at", nullable = false, updatable = false)
    private Instant startsAt;

    /** When the alert auto-hides. The one mutable field — expire-now brings it forward. */
    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    /** DB-authoritative ({@code default now()}); generated on insert and read back. */
    @Generated(event = EventType.INSERT)
    @Column(name = "created_at", nullable = false, insertable = false, updatable = false)
    private Instant createdAt;

    /** The actor uid, from the verified admin token — attribution for the history. Immutable. */
    @Column(name = "created_by", nullable = false, updatable = false)
    private String createdBy;

    /** Required by JPA. */
    protected Alert() {}

    /**
     * Create a global alert. {@code createdAt} is DB-generated. The caller is responsible for a
     * well-ordered window ({@code startsAt < expiresAt}) — enforced up front by {@code CreateAlertRequest}
     * so a bad window is a {@code 400}, never a persisted row.
     */
    public Alert(
            String message,
            AlertLevel level,
            AlertDismissal dismissal,
            Instant startsAt,
            Instant expiresAt,
            String createdBy) {
        this.message = message;
        this.level = level;
        this.dismissal = dismissal;
        this.scope = SCOPE_GLOBAL;
        this.startsAt = startsAt;
        this.expiresAt = expiresAt;
        this.createdBy = createdBy;
    }

    /**
     * Pull a live (or scheduled) alert early by bringing {@code expiresAt} forward to {@code now} — the
     * expire-now admin action. Only ever moves the expiry <em>earlier</em>: if the alert already
     * expired before {@code now}, its original expiry is kept so the history stays truthful about when
     * it actually ended (idempotent re-expire is a no-op).
     */
    public void expireNow(Instant now) {
        if (now.isBefore(this.expiresAt)) {
            this.expiresAt = now;
        }
    }

    /** The derived lifecycle status against the given (server) instant — never stored. */
    public AlertStatus status(Instant now) {
        return AlertStatus.at(startsAt, expiresAt, now);
    }

    public Long getId() {
        return id;
    }

    public String getMessage() {
        return message;
    }

    public AlertLevel getLevel() {
        return level;
    }

    public AlertDismissal getDismissal() {
        return dismissal;
    }

    public String getScope() {
        return scope;
    }

    public Instant getStartsAt() {
        return startsAt;
    }

    public Instant getExpiresAt() {
        return expiresAt;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public String getCreatedBy() {
        return createdBy;
    }
}
