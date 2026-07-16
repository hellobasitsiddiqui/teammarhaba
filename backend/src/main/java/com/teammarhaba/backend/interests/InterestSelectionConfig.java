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
 * <p>This is the read path only. No validation policy / no {@code min <= max} enforcement lives here —
 * enforcing the bounds at selection time belongs to a later ticket (I4); I1 ships only the read path.
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
}
