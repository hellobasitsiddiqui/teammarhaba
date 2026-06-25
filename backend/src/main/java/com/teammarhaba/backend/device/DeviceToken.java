package com.teammarhaba.backend.device;

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
 * A push registration token for one of a user's devices (TM-283, epic TM-277).
 *
 * <p>Schema is owned by Flyway ({@code V9__create_device_tokens}); Hibernate runs validate-only, so
 * this mapping must match the table exactly. The {@code token} is the natural key for a device and is
 * globally {@code UNIQUE}, so a re-registration of the same token {@linkplain #refresh upserts} the
 * existing row (new owner/platform + bumped {@code updatedAt}) rather than duplicating it. The send-
 * push service (TM-284) reads tokens by user to target a push, and prunes a token by value when FCM
 * reports it {@code unregistered}.
 *
 * <p>Stored against {@code user_id} (the {@code users.id} surrogate key) with {@code ON DELETE
 * CASCADE}: a removed account has no devices to push to. We keep only the FK id here rather than a
 * JPA association, to stay decoupled from the {@code User} aggregate's {@code @SQLRestriction}.
 */
@Entity
@Table(name = "device_tokens")
public class DeviceToken {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "token", nullable = false, unique = true, updatable = false)
    private String token;

    @Enumerated(EnumType.STRING)
    @Column(name = "platform", nullable = false)
    private DevicePlatform platform;

    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    /** Required by JPA. */
    protected DeviceToken() {
    }

    public DeviceToken(Long userId, String token, DevicePlatform platform, Instant when) {
        this.userId = userId;
        this.token = token;
        this.platform = platform;
        this.updatedAt = when;
    }

    public Long getId() {
        return id;
    }

    public Long getUserId() {
        return userId;
    }

    public String getToken() {
        return token;
    }

    public DevicePlatform getPlatform() {
        return platform;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    /**
     * Re-register an existing token (idempotent upsert): re-point it at the caller and refresh its
     * platform + {@code updatedAt}. The token value itself never changes (it's the natural key).
     */
    public void refresh(Long userId, DevicePlatform platform, Instant when) {
        this.userId = userId;
        this.platform = platform;
        this.updatedAt = when;
    }
}
