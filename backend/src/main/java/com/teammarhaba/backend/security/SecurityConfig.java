package com.teammarhaba.backend.security;

import static org.springframework.security.config.Customizer.withDefaults;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

/**
 * Web authorization for the base. Today it does exactly what TM-74 needs and no more: keep
 * the operational health surface public while requiring authentication for the
 * internals-revealing actuator endpoints.
 *
 * <ul>
 *   <li><b>{@code /actuator/health}</b> (and its {@code liveness}/{@code readiness} groups) —
 *       {@code permitAll}, so Cloud Run probes and load balancers reach it anonymously.</li>
 *   <li><b>every other {@code /actuator/**}</b> ({@code /info}, {@code /metrics}, …) —
 *       {@code authenticated}, so internals aren't exposed to anonymous callers.</li>
 *   <li><b>everything else</b> (the {@code /api/v1} surface, {@code /health}) — {@code permitAll}
 *       for now; real caller authentication (Firebase ID-token verification) is layered on in
 *       TM-79, which extends this chain.</li>
 * </ul>
 *
 * <p>HTTP Basic is the challenge mechanism so an anonymous hit on a protected endpoint gets a
 * clean {@code 401} (not a {@code 302} to a login page). CSRF is disabled and sessions are
 * stateless — this is a token-style JSON API, not a browser form app. Response security headers
 * stay owned by {@link SecurityHeadersFilter} (TM-78), so Spring Security's own header writer is
 * disabled to keep a single source of truth.
 */
@Configuration
public class SecurityConfig {

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(auth ->
                        auth.requestMatchers("/actuator/health", "/actuator/health/**")
                                .permitAll()
                                .requestMatchers("/actuator/**")
                                .authenticated()
                                .anyRequest()
                                .permitAll())
                .httpBasic(withDefaults())
                .csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .headers(headers -> headers.disable());
        return http.build();
    }
}
