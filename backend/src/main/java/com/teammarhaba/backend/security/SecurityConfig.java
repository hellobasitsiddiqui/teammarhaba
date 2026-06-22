package com.teammarhaba.backend.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.firebase.auth.FirebaseAuth;
import com.teammarhaba.backend.auth.FirebaseAuthenticationFilter;
import com.teammarhaba.backend.auth.RestAccessDeniedHandler;
import com.teammarhaba.backend.auth.RestAuthenticationEntryPoint;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfigurationSource;

/**
 * Web authorization for the API — <strong>default-deny</strong> (TM-79, extending the TM-74
 * actuator split). Every route requires an authenticated caller except an explicit permit-list:
 *
 * <ul>
 *   <li><b>{@code /health}</b> — the Cloud Run liveness probe.</li>
 *   <li><b>{@code /actuator/health}</b> (+ {@code liveness}/{@code readiness} groups) — orchestration probes.</li>
 *   <li><b>{@code /v3/api-docs/**}, {@code /swagger-ui/**}</b> — the OpenAPI docs (TM-76; non-prod only, disabled in prod).</li>
 * </ul>
 *
 * <p>Everything else — the whole {@code /api/v1} surface and the rest of {@code /actuator/**}
 * ({@code /info}, {@code /metrics}) — is {@code authenticated}. Authentication is established by
 * {@link FirebaseAuthenticationFilter} (verifies the {@code Bearer} Firebase ID token); an
 * unauthenticated request to a protected route gets a uniform RFC 7807 {@code 401} from
 * {@link RestAuthenticationEntryPoint}, and an authenticated-but-unauthorized one (e.g. a
 * {@code USER} hitting an {@code @PreAuthorize("hasRole('ADMIN')")} route — method security is on,
 * see {@link MethodSecurityConfig}) gets a uniform {@code 403} from {@link RestAccessDeniedHandler}.
 *
 * <p>Sessions are stateless and CSRF is off — this is a token API, not a browser form app.
 * Response security headers stay owned by {@link SecurityHeadersFilter} (TM-78), so Spring
 * Security's own header writer is disabled to keep a single source of truth.
 */
@Configuration
public class SecurityConfig {

    @Bean
    SecurityFilterChain securityFilterChain(
            HttpSecurity http,
            ObjectProvider<FirebaseAuth> firebaseAuth,
            ObjectMapper objectMapper,
            CorsConfigurationSource corsConfigurationSource)
            throws Exception {
        http.authorizeHttpRequests(auth -> auth.requestMatchers(
                                "/health",
                                "/actuator/health",
                                "/actuator/health/**",
                                "/v3/api-docs/**",
                                "/swagger-ui/**")
                        .permitAll()
                        .anyRequest()
                        .authenticated())
                // CORS for the browser SPA (TM-104). The CorsFilter runs ahead of auth so the
                // preflight OPTIONS is answered without a token; the allow-list lives in CorsConfig.
                .cors(cors -> cors.configurationSource(corsConfigurationSource))
                .addFilterBefore(
                        new FirebaseAuthenticationFilter(firebaseAuth),
                        UsernamePasswordAuthenticationFilter.class)
                .exceptionHandling(ex -> ex.authenticationEntryPoint(new RestAuthenticationEntryPoint(objectMapper))
                        .accessDeniedHandler(new RestAccessDeniedHandler(objectMapper)))
                .csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .headers(headers -> headers.disable());
        return http.build();
    }
}
