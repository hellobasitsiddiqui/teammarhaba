package com.teammarhaba.backend.user;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/**
 * A TeamMarhaba account, keyed by the Firebase UID from the verified ID token (TM-79).
 *
 * <p>Schema is owned by Flyway ({@code V2__create_users}); Hibernate runs validate-only, so
 * this mapping must match the table exactly. Behaviour is intentionally absent here — accounts
 * are provisioned just-in-time on first login (TM-112), {@code role} is mirrored from the
 * Firebase custom claim (TM-110), and the auditing timestamps + optimistic-lock {@code version}
 * move onto a reusable base in TM-114. For now this is a plain mapped record.
 */
@Entity
@Table(name = "users")
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

    public Role getRole() {
        return role;
    }

    public boolean isEnabled() {
        return enabled;
    }
}
