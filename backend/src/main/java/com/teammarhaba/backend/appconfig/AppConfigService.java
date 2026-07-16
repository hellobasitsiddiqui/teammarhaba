package com.teammarhaba.backend.appconfig;

import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Read + write path for the mutable runtime config store (TM-773 read; TM-774 write). Resolves a
 * setting from the {@link AppConfig} table by key, falling back to a caller-supplied default when the
 * key is absent (or, for typed reads, unparseable) — so a missing or malformed row can never take the
 * feature down; it just uses the default.
 *
 * <p>The write path ({@link #setInt}) was deferred by TM-773 to its follow-up "I2" (TM-774), which is
 * where the admin interests-config endpoint lives. Reads go straight through the repository (no
 * in-memory cache): the config table is tiny and read rarely, so a cache would add invalidation
 * complexity (and a staleness bug now that values change at runtime) for no measurable win.
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

    /**
     * Persist an integer setting under {@code key} (TM-774 write path). Upsert semantics: if a row for
     * the key exists its value is updated and {@code updated_at} bumped ({@link AppConfig#setValue}); if
     * none exists a new row is inserted. The two interests-selection rows are seeded by V45, so the
     * update branch is the live path and the insert branch is a fail-safe for a missing row (parallels
     * the read path's default-on-absent stance). {@code @Transactional} (not read-only) so the write
     * commits; {@code @Version} on {@link AppConfig} yields the standard 409 on a concurrent stale write.
     */
    @Transactional
    public void setInt(String key, int value) {
        Instant now = Instant.now();
        String stored = Integer.toString(value);
        repo.findByConfigKey(key)
                .ifPresentOrElse(
                        row -> row.setValue(stored, now),
                        () -> repo.save(new AppConfig(key, stored, null, now)));
    }
}
