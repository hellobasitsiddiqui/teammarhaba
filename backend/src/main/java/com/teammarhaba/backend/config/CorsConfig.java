package com.teammarhaba.backend.config;

import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

/**
 * CORS for the API (TM-104). Applies only to {@code /api/**} — the browser SPA's surface —
 * with origins from {@link CorsProperties} (config-driven, never {@code *}). Allows the
 * {@code Authorization} header so the web client can send the Firebase {@code Bearer} token.
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
        return source;
    }
}
