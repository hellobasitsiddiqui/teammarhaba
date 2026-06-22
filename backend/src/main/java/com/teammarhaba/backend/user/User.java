package com.teammarhaba.backend.user;

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
import org.hibernate.annotations.SQLRestriction;

/**
 * A TeamMarhaba account, keyed by the Firebase UID from the verified ID token (TM-79).
 *
 * <p>Schema is owned by Flyway ({@code V2__create_users}, {@code V3__users_soft_delete_and_version});
 * Hibernate runs validate-only, so this mapping must match the table exactly.
 *
 * <p>Two cross-cutting data conventions land here first (TM-114), to be reused by later entities:
 *
 * <ul>
 *   <li><b>Soft-delete</b> — {@code deletedAt} (NULL = active). Deleting an account
 *       {@linkplain #markDeleted tombstones} the row rather than removing it, so it stays
 *       recoverable ({@link UserService#restore}) and its history survives. The
 *       {@code @SQLRestriction} excludes tombstoned rows from every normal query, so callers get
 *       "active only" by default; the restore path reads through it with a native query. This is
 *       the <em>deletion</em> path and is distinct from the {@code enabled} flag, which suspends an
 *       active account without hiding it.
 *   <li><b>Optimistic concurrency</b> — {@code @Version}. Concurrent edits to the same row fail the
 *       second writer with a {@code 409} (via {@code GlobalExceptionHandler}) instead of silently
 *       overwriting the first.
 * </ul>
 *
 * <p>Accounts are provisioned just-in-time on first login (TM-112) and {@code role} is mirrored
 * from the Firebase custom claim (TM-110).
 */
@Entity
@Table(name = "users")
@SQLRestriction("deleted_at is null") // soft-deleted rows are hidden from all normal queries
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "firebase_uid", nullable = false, unique = true, updatable = false)
    private String firebaseUid;

    @Column(name = "email")
    private String email;

    @Column(name = "display_name")
    private String displayName;

    @Enumerated(EnumType.STRING)
    @Column(name = "role", nullable = false)
    private Role role = Role.USER;

    @Column(name = "enabled", nullable = false)
    private boolean enabled = true;

    /** Soft-delete marker: {@code null} = active, non-null = tombstoned at that instant. */
    @Column(name = "deleted_at")
    private Instant deletedAt;

    /** Optimistic-lock counter; Hibernate bumps it on every update and rejects stale writes. */
    @Version
    @Column(name = "version", nullable = false)
    private long version;

    /** Required by JPA. */
    protected User() {
    }

    public User(String firebaseUid, String email, String displayName) {
        this.firebaseUid = firebaseUid;
        this.email = email;
        this.displayName = displayName;
    }

    public Long getId() {
        return id;
    }

    public String getFirebaseUid() {
        return firebaseUid;
    }

    public String getEmail() {
        return email;
    }

    public String getDisplayName() {
        return displayName;
    }

    /** Profile update (TM-112). Identity fields (uid/email) come from the token, not the client. */
    public void setDisplayName(String displayName) {
        this.displayName = displayName;
    }

    public Role getRole() {
        return role;
    }

    public boolean isEnabled() {
        return enabled;
    }

    public Instant getDeletedAt() {
        return deletedAt;
    }

    /** {@code true} once this account has been soft-deleted (tombstoned). */
    public boolean isDeleted() {
        return deletedAt != null;
    }

    public long getVersion() {
        return version;
    }

    /** Soft-delete: tombstone the row so normal queries hide it. Package-private — go via the service. */
    void markDeleted(Instant when) {
        this.deletedAt = when;
    }

    /** Undo a soft-delete, making the account active again. Idempotent on an already-active row. */
    void restore() {
        this.deletedAt = null;
    }
}
