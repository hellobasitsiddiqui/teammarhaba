package com.teammarhaba.backend.interests;

import com.teammarhaba.backend.appconfig.AppConfigService;
import org.springframework.stereotype.Component;

/**
 * The single typed read path for the interests selection bounds (TM-773) — min/max number of interests
 * a user must/may select. Wraps {@link AppConfigService} so the {@code app_config} string keys live in
 * exactly one place; interests-side code (I4+) reads {@link #minSelections()} / {@link #maxSelections()}
 * rather than the raw keys.
 *
 * <p>These are backed by the DB rows {@code interests.min_selections} / {@code interests.max_selections}
 * (seeded 1 / 3 in {@code V45__create_interests}) precisely because they must be MUTABLE at runtime — a
 * later ticket (I2) exposes an admin endpoint to change them. That is why this is a DB-backed read and
 * NOT a {@code @ConfigurationProperties}/{@code @Value} constant: a bound record can't change without a
 * redeploy. The 1/3 defaults here are only the fail-safe used if the seed rows are ever missing.
 *
 * <p>TM-773 shipped the read path; TM-774 adds the write passthroughs ({@link #setMinSelections(int)} /
 * {@link #setMaxSelections(int)}) that the admin interests-config endpoint uses — keeping the
 * {@code app_config} string keys in exactly one place on the write side too. No {@code min <= max}
 * enforcement lives here (that cross-field rule is validated at the admin request edge + defensively in
 * the admin service); this class remains the single typed key/value seam for the two settings.
 */
@Component
public class InterestSelectionConfig {

    static final String MIN_KEY = "interests.min_selections";
    static final String MAX_KEY = "interests.max_selections";
    static final int MIN_DEFAULT = 1;
    static final int MAX_DEFAULT = 3;

    private final AppConfigService appConfig;

    public InterestSelectionConfig(AppConfigService appConfig) {
        this.appConfig = appConfig;
    }

    /** Minimum interests a user must select (DB-backed; default {@value #MIN_DEFAULT}). */
    public int minSelections() {
        return appConfig.getInt(MIN_KEY, MIN_DEFAULT);
    }

    /** Maximum interests a user may select (DB-backed; default {@value #MAX_DEFAULT}). */
    public int maxSelections() {
        return appConfig.getInt(MAX_KEY, MAX_DEFAULT);
    }

    /** Persist the minimum-selections bound (TM-774 admin write); routes through the one {@link #MIN_KEY}. */
    public void setMinSelections(int value) {
        appConfig.setInt(MIN_KEY, value);
    }

    /** Persist the maximum-selections bound (TM-774 admin write); routes through the one {@link #MAX_KEY}. */
    public void setMaxSelections(int value) {
        appConfig.setInt(MAX_KEY, value);
    }
}
