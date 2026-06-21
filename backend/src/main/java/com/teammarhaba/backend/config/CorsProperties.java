package com.teammarhaba.backend.config;

import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * CORS allow-list for the browser SPA (TM-104), bound from {@code app.cors.*}.
 *
 * <p>Origins are explicit per environment ({@code dev} = the local web origin; {@code prod} =
 * the Firebase Hosting domains) — never a wildcard. Absent config binds to an empty list, which
 * means "allow no cross-origin caller" (safe default for {@code test}).
 */
@ConfigurationProperties(prefix = "app.cors")
public record CorsProperties(List<String> allowedOrigins) {

    public CorsProperties {
        allowedOrigins = allowedOrigins == null ? List.of() : List.copyOf(allowedOrigins);
    }
}
