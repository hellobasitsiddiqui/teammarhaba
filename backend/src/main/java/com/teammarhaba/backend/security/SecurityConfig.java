package com.teammarhaba.backend.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.firebase.auth.FirebaseAuth;
import com.teammarhaba.backend.auth.FirebaseAuthenticationFilter;
import com.teammarhaba.backend.auth.RestAccessDeniedHandler;
import com.teammarhaba.backend.auth.RestAuthenticationEntryPoint;
import com.teammarhaba.backend.user.UserRepository;
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
 *   <li><b>{@code /version}</b> — public build provenance (sha/build time/revision) the web first page reads (TM-142).</li>
 *   <li><b>{@code /actuator/health}</b> (+ {@code liveness}/{@code readiness} groups) — orchestration probes.</li>
 *   <li><b>{@code /v3/api-docs/**}, {@code /swagger-ui/**}</b> — the OpenAPI docs (TM-76; non-prod only, disabled in prod).</li>
 *   <li><b>{@code /api/v1/auth/email-code/request}, {@code .../verify}</b> — passwordless email-code
 *       login (TM-234): you can't hold a token before you sign in, so these are permit-listed and
 *       guarded instead by per-address rate-limiting + code validation in {@code EmailCodeService}.</li>
 *   <li><b>{@code /api/v1/alerts/active}</b> — the site-wide alert-banner read (TM-243): a public,
 *       non-sensitive notices feed the web banner polls, allow-listed so a warning can show pre-login.
 *       Read-only; admin writes stay authenticated + {@code ADMIN}-gated under {@code /api/v1/admin/alerts}.</li>
 *   <li><b>{@code /api/v1/payments/revolut/webhook}</b> — the payment provider webhook (TM-478): Revolut,
 *       not a signed-in user, calls it to report a settled order, so it cannot carry a token. Permit-listed
 *       but authenticity-guarded by the {@code Revolut-Signature} HMAC (an unverifiable payload gets a 401).</li>
 * </ul>
 *
 * <p>The rest of {@code /actuator/**} ({@code /info}, {@code /metrics}) is <strong>ADMIN-only</strong>
 * (TM-723) — build/config and runtime metrics are an information-disclosure surface, so an authenticated
 * non-admin gets a {@code 403}, not the data. Everything else — the whole {@code /api/v1} surface — is
 * {@code authenticated}. Authentication is established by
 * {@link FirebaseAuthenticationFilter} (verifies the {@code Bearer} Firebase ID token); an
 * unauthenticated request to a protected route gets a uniform RFC 7807 {@code 401} from
 * {@link RestAuthenticationEntryPoint}, and an authenticated-but-unauthorized one (e.g. a
 * {@code USER} hitting an {@code @PreAuthorize("hasRole('ADMIN')")} route — method security is on,
 * see {@link MethodSecurityConfig}) gets a uniform {@code 403} from {@link RestAccessDeniedHandler}.
 *
 * <p>Sessions are stateless and CSRF is off — this is a token API, not a browser form app.
 * Response security headers stay owned by {@link SecurityHeadersFilter} (TM-78), so Spring
 * Security's own header writer is disabled to keep a single source of truth.
 *
 * <p>A per-client {@link RateLimitFilter} (TM-158) is slotted in just after the auth filter to cap
 * {@code /api/**} traffic (keyed by {@code uid}, else IP) — bounding abuse / cheap DoS beyond
 * Firebase's login lockout, and returning a uniform {@code 429} with {@code Retry-After} over the
 * limit. The health/readiness probes sit outside {@code /api/**} and are unaffected.
 */
@Configuration
public class SecurityConfig {

    @Bean
    SecurityFilterChain securityFilterChain(
            HttpSecurity http,
            ObjectProvider<FirebaseAuth> firebaseAuth,
            ObjectProvider<UserRepository> users,
            ObjectMapper objectMapper,
            ObjectProvider<RateLimiter> rateLimiter,
            ObjectProvider<RateLimitProperties> rateLimitProperties,
            CorsConfigurationSource corsConfigurationSource)
            throws Exception {
        // The auth filter that establishes the VerifiedUser principal. Held in a variable so the
        // rate-limit filter (TM-158) can be slotted in right AFTER it — that way the SecurityContext
        // already carries the uid, letting RateLimiter key its bucket per-account (else per-IP). The
        // repository is passed (lazily) so the filter can enforce the suspend/disable gate inbound
        // (TM-741/TM-742) — a suspended account is refused per request, not just cut off from push.
        FirebaseAuthenticationFilter firebaseAuthenticationFilter =
                new FirebaseAuthenticationFilter(firebaseAuth, users);
        http.authorizeHttpRequests(auth -> auth.requestMatchers(
                                "/health",
                                "/version",
                                "/actuator/health",
                                "/actuator/health/**",
                                "/v3/api-docs/**",
                                "/swagger-ui/**",
                                // Passwordless email-code login (TM-234): obtaining a session must be
                                // reachable WITHOUT a token. Both routes are rate-limited + validated
                                // server-side (EmailCodeService); verify returns a Firebase custom token.
                                "/api/v1/auth/email-code/request",
                                "/api/v1/auth/email-code/verify",
                                // Site-wide alert banner read (TM-243): the active-alerts feed the web
                                // banner polls. Allow-listed so a warning (e.g. a heatwave notice) can
                                // show PRE-LOGIN. Read-only + non-sensitive by contract — the response
                                // carries only the notice (id/message/level/dismissal), never the actor
                                // or schedule, and the message must never carry sensitive data. Admin
                                // writes stay under /api/v1/admin/alerts (authenticated + ADMIN-gated).
                                "/api/v1/alerts/active",
                                // Payment provider webhook (TM-478): Revolut calls this to report an order
                                // settled — it is not an authenticated user, so it cannot carry a Firebase
                                // token and must be permit-listed. Authenticity is enforced instead by the
                                // Revolut-Signature HMAC, verified in RevolutPaymentProvider before anything
                                // is confirmed (a payload that does not verify gets a 401 and changes
                                // nothing), plus a ~5-minute timestamp replay window (TM-623). Inert until
                                // the SERVER-SIDE membership flag (app.membership.enabled) ships: the PAY
                                // checkout branch is 403 while it is off, so no order is ever PENDING to
                                // confirm — a guarantee the web-only flag could never make (TM-623).
                                "/api/v1/payments/revolut/webhook",
                                // Emulator-only e2e peek for the code (TM-234). The handler bean only
                                // exists when FIREBASE_AUTH_EMULATOR_HOST is set (unset in dev/prod), so
                                // in any real environment this matches nothing and 404s — the permit is
                                // inert there. Lives outside the api package, hence the unprefixed path.
                                "/auth/email-code/peek")
                        .permitAll()
                        // Operational actuator endpoints expose build/config and runtime metrics — an
                        // information-disclosure surface, so restrict them to ADMIN (TM-723). Health
                        // stays public above for orchestration probes; everything else needs auth.
                        .requestMatchers("/actuator/info", "/actuator/metrics", "/actuator/metrics/**")
                        .hasRole("ADMIN")
                        .anyRequest()
                        .authenticated())
                // CORS for the browser SPA (TM-104). The CorsFilter runs ahead of auth so the
                // preflight OPTIONS is answered without a token; the allow-list lives in CorsConfig.
                .cors(cors -> cors.configurationSource(corsConfigurationSource))
                .addFilterBefore(firebaseAuthenticationFilter, UsernamePasswordAuthenticationFilter.class)
                .exceptionHandling(ex -> ex.authenticationEntryPoint(new RestAuthenticationEntryPoint(objectMapper))
                        .accessDeniedHandler(new RestAccessDeniedHandler(objectMapper)))
                .csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .headers(headers -> headers.disable());

        // Per-client rate limit on /api/** (TM-158), slotted in right AFTER the auth filter so it can
        // key by uid; a no-op when disabled or off the API surface (see RateLimitFilter#shouldNotFilter).
        // Resolved via ObjectProvider (like FirebaseAuth above) so a slim @WebMvcTest slice that imports
        // this config but doesn't supply the beans still builds a working chain — the filter is simply
        // omitted there. The full application context always has both, so the guard is always present.
        RateLimiter limiter = rateLimiter.getIfAvailable();
        RateLimitProperties limitProps = rateLimitProperties.getIfAvailable();
        if (limiter != null && limitProps != null) {
            http.addFilterAfter(
                    new RateLimitFilter(limiter, limitProps, objectMapper), FirebaseAuthenticationFilter.class);
        }
        return http.build();
    }
}
