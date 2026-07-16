package com.teammarhaba.backend.appconfig;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Read path for the mutable runtime config store (TM-773). Resolves a setting from the {@link AppConfig}
 * table by key, falling back to a caller-supplied default when the key is absent (or, for typed reads,
 * unparseable) — so a missing or malformed row can never take the feature down; it just uses the default.
 *
 * <p>Read-only in I1: there is no write method here — the admin write endpoint is TM-773's follow-up I2.
 * Reads go straight through the repository (no in-memory cache): the config table is tiny and read
 * rarely, so a cache would add invalidation complexity (and a subtle staleness bug once I2 lets values
 * change at runtime) for no measurable win.
 */
@Service
public class AppConfigService {

    private static final Logger log = LoggerFactory.getLogger(AppConfigService.class);

    private final AppConfigRepository repo;

    public AppConfigService(AppConfigRepository repo) {
        this.repo = repo;
    }

    /**
     * The string value for {@code key}, or {@code defaultValue} if no row exists for that key.
     */
    @Transactional(readOnly = true)
    public String getString(String key, String defaultValue) {
        return repo.findByConfigKey(key).map(AppConfig::getConfigValue).orElse(defaultValue);
    }

    /**
     * The integer value for {@code key}, or {@code defaultValue} if the key is absent OR its stored
     * value is not a valid integer — the fail-safe path: a malformed config value logs a warning and
     * yields the default rather than throwing.
     */
    @Transactional(readOnly = true)
    public int getInt(String key, int defaultValue) {
        String raw = repo.findByConfigKey(key).map(AppConfig::getConfigValue).orElse(null);
        if (raw == null) {
            return defaultValue;
        }
        try {
            return Integer.parseInt(raw.trim());
        } catch (NumberFormatException e) {
            log.warn("app_config key '{}' has non-integer value '{}'; using default {}", key, raw, defaultValue);
            return defaultValue;
        }
    }
}
