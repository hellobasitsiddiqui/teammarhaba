package com.teammarhaba.backend.appconfig;

import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

/**
 * Data access for {@link AppConfig} (TM-773) — the mutable runtime config store. The config key is
 * the natural key; {@link #findByConfigKey(String)} backs {@code AppConfigService}'s typed reads.
 */
public interface AppConfigRepository extends JpaRepository<AppConfig, Long> {

    /** The config row for the given key, if present. */
    Optional<AppConfig> findByConfigKey(String configKey);
}
