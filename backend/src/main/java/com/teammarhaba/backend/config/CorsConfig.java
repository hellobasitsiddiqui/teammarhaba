package com.teammarhaba.backend.config;

import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

/**
 * CORS for the API (TM-104) plus the public diagnostics endpoints (TM-308), with origins from
 * {@link CorsProperties} (config-driven, never {@code *}). Allows the {@code Authorization} header
 * so the web client can send the Firebase {@code Bearer} token.
 *
 * <p>The same allow-list is registered for three path groups so every browser-reachable surface is
 * covered consistently (one source of truth, no per-controller {@code @CrossOrigin}):
 *
 * <ul>
 *   <li>{@code /api/**} — the browser SPA's authenticated surface.</li>
 *   <li>{@code /version} — public build provenance the web first page fetches cross-origin to show
 *       the backend's build next to the web's (TM-142). It lives at the root (unversioned, outside
 *       {@code /api/**}), so it was previously missing the {@code Access-Control-Allow-Origin}
 *       header and the browser/WebView fetch was blocked by CORS (TM-308).</li>
 *   <li>{@code /health} — the public health probe, also read by the web first page; same root-level
 *       gap, covered here for consistency.</li>
 *   <li>{@code /actuator/**} — the admin Diagnostics panel ({@code admin.js loadDiagnostic()}) does an
 *       authenticated cross-origin fetch of {@code /actuator/info} + {@code /actuator/metrics} (TM-569).
 *       The {@code Authorization} header makes it a non-simple request, so the browser sends a CORS
 *       preflight; without a registration here the preflight got no {@code Access-Control-Allow-Origin}
 *       header and every admin saw "Couldn't reach the backend" in prod (web and backend are different
 *       origins). Covered as a group so {@code /actuator/health} (already public) and any future actuator
 *       endpoint stay consistent. CORS only governs response headers — authorization is unchanged, so
 *       {@code /info}/{@code /metrics} remain {@code authenticated} (see {@code SecurityConfig}).</li>
 * </ul>
 *
 * <p>Credentials (cookies) are intentionally <strong>not</strong> allowed: this is a stateless
 * token API, so there is nothing cookie-based to share. The {@link CorsConfigurationSource}
 * bean is consumed by {@code SecurityConfig.cors(...)}.
 */
@Configuration
public class CorsConfig {

    @Bean
    CorsConfigurationSource corsConfigurationSource(CorsProperties properties) {
        CorsConfiguration cors = new CorsConfiguration();
        cors.setAllowedOrigins(properties.allowedOrigins());
        cors.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        cors.setAllowedHeaders(List.of("Authorization", "Content-Type"));
        cors.setMaxAge(3600L);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", cors);
        // Public root-level diagnostics endpoints the web first page fetches cross-origin (TM-308).
        source.registerCorsConfiguration("/version", cors);
        source.registerCorsConfiguration("/health", cors);
        // Admin Diagnostics panel fetches /actuator/info + /actuator/metrics cross-origin with a
        // Bearer token (TM-569); register the actuator group so the preflight carries the allow-list.
        source.registerCorsConfiguration("/actuator/**", cors);
        return source;
    }
}
