package com.teammarhaba.backend.appconfig;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;

/**
 * One mutable runtime configuration setting (TM-773) — a single key/value row in the app's first
 * admin-editable config store. The value is stored as text; typed reads ({@code int} etc.) parse it
 * at read time (see {@code AppConfigService}).
 *
 * <p>Schema is owned by Flyway ({@code V45__create_interests}, which also seeds the interests
 * min/max-selection defaults); Hibernate runs validate-only, so this mapping must match the table
 * exactly. I1 ships this storage + a read path only — the admin WRITE endpoint that lets these be
 * changed at runtime is TM-773's follow-up I2 and is out of scope here. The {@link #setValue} /
 * {@link #touch} mutators and the {@code @Version} optimistic lock are present so that write path
 * gets locking for free when it lands.
 */
@Entity
@Table(name = "app_config")
public class AppConfig {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** The setting key, e.g. "interests.max_selections". Required, globally unique, never re-keyed. */
    @Column(name = "config_key", nullable = false, updatable = false)
    private String configKey;

    /** The setting value as text (required). Typed reads parse this. */
    @Column(name = "config_value", nullable = false)
    private String configValue;

    /** Optional human-readable note on what the setting does; {@code null} = none. */
    @Column(name = "description")
    private String description;

    /** DB-authoritative creation timestamp ({@code DEFAULT now()}); read-only on the entity. */
    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private Instant createdAt;

    /** App-managed: set on create and {@linkplain #touch bumped} on every mutation (the I2 write path). */
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    /** Optimistic-lock counter; Hibernate bumps it on update and rejects stale writes. */
    @Version
    @Column(name = "version", nullable = false)
    private long version;

    /** Required by JPA. */
    protected AppConfig() {
    }

    /** A new config row with the given key, value and optional description. */
    public AppConfig(String configKey, String configValue, String description, Instant now) {
        this.configKey = configKey;
        this.configValue = configValue;
        this.description = description;
        this.updatedAt = now;
    }

    public Long getId() {
        return id;
    }

    public String getConfigKey() {
        return configKey;
    }

    public String getConfigValue() {
        return configValue;
    }

    /** Change the stored value and bump {@code updatedAt} (the future I2 admin write path). */
    public void setValue(String configValue, Instant when) {
        this.configValue = configValue;
        this.updatedAt = when;
    }

    public String getDescription() {
        return description;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    /** Bump {@code updatedAt} after an edit (the future write path's responsibility). */
    public void touch(Instant when) {
        this.updatedAt = when;
    }

    public long getVersion() {
        return version;
    }
}
