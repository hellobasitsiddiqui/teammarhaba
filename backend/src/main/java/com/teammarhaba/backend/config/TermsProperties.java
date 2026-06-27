package com.teammarhaba.backend.config;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * The single source of truth for the <strong>current</strong> terms/privacy version (TM-170),
 * bound from {@code app.terms.*}. The client compares this against the user's
 * {@code termsAcceptedVersion} (TM-163) to decide whether to show the acceptance gate: a brand-new
 * user (never accepted) OR a returning user whose accepted version is older than this one is gated
 * until they re-accept.
 *
 * <p>It is a config <em>constant</em> rather than a stored row: bumping the published terms is a
 * deploy-time change of {@code APP_TERMS_CURRENT_VERSION} (or this default), which immediately
 * re-prompts everyone whose accepted version no longer matches. Exposed read-only on {@code GET
 * /api/v1/me} as {@code currentTermsVersion} so the web/native client never has to hard-code its
 * own copy and the gate decision stays server-driven.
 *
 * @param currentVersion the published terms version, e.g. {@code "2026-06-01"}; required, non-blank,
 *     and {@code ≤ 64} chars to match the {@code terms_accepted_version} column (migration V6) it is
 *     compared against.
 */
@Validated
@ConfigurationProperties(prefix = "app.terms")
public record TermsProperties(@NotBlank @Size(max = 64) String currentVersion) {

    /** The shipped default when nothing overrides {@code app.terms.current-version}. */
    public static final String DEFAULT_CURRENT_VERSION = "2026-06-01";

    public TermsProperties {
        if (currentVersion == null || currentVersion.isBlank()) {
            currentVersion = DEFAULT_CURRENT_VERSION;
        }
    }
}
