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

    // Self-service profile fields (TM-162). All user-editable via PATCH /api/v1/me; all nullable
    // except notificationPref, which defaults to EMAIL. Schema owned by V5__users_profile_fields.
    @Column(name = "first_name")
    private String firstName;

    @Column(name = "last_name")
    private String lastName;

    @Column(name = "city")
    private String city;

    @Column(name = "age")
    private Integer age;

    @Column(name = "phone")
    private String phone;

    @Enumerated(EnumType.STRING)
    @Column(name = "notification_pref", nullable = false)
    private NotificationPreference notificationPref = NotificationPreference.EMAIL;

    @Column(name = "timezone")
    private String timezone;

    @Column(name = "locale")
    private String locale;

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

    public String getFirstName() {
        return firstName;
    }

    public String getLastName() {
        return lastName;
    }

    public String getCity() {
        return city;
    }

    public Integer getAge() {
        return age;
    }

    public String getPhone() {
        return phone;
    }

    public NotificationPreference getNotificationPref() {
        return notificationPref;
    }

    public String getTimezone() {
        return timezone;
    }

    public String getLocale() {
        return locale;
    }

    /**
     * Apply a partial profile update (TM-162): each non-{@code null} field overwrites its column,
     * a {@code null} leaves it unchanged (PATCH semantics). Identity ({@code uid}/{@code email}) is
     * never updatable here. Mutation lives on the entity so dirty-checking flushes it on commit.
     */
    public void applyProfile(ProfileUpdate p) {
        if (p.displayName() != null) {
            this.displayName = p.displayName();
        }
        if (p.firstName() != null) {
            this.firstName = p.firstName();
        }
        if (p.lastName() != null) {
            this.lastName = p.lastName();
        }
        if (p.city() != null) {
            this.city = p.city();
        }
        if (p.age() != null) {
            this.age = p.age();
        }
        if (p.phone() != null) {
            this.phone = p.phone();
        }
        if (p.notificationPref() != null) {
            this.notificationPref = p.notificationPref();
        }
        if (p.timezone() != null) {
            this.timezone = p.timezone();
        }
        if (p.locale() != null) {
            this.locale = p.locale();
        }
    }

    public Role getRole() {
        return role;
    }

    /** Mirror the role onto the row (TM-111). The Firebase custom claim stays the auth source of truth. */
    void setRole(Role role) {
        this.role = role;
    }

    public boolean isEnabled() {
        return enabled;
    }

    /** Suspend ({@code false}) or reinstate ({@code true}) an active account (TM-111 admin action). */
    void setEnabled(boolean enabled) {
        this.enabled = enabled;
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
