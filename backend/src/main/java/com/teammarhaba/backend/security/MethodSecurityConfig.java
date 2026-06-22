package com.teammarhaba.backend.security;

import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;

/**
 * Turns on Spring Security method security (TM-111) so {@code @PreAuthorize} is enforced — e.g. the
 * admin user-management endpoints gated by {@code @PreAuthorize("hasRole('ADMIN')")}. A denied call
 * throws {@code AccessDeniedException}, which {@link SecurityConfig}'s access-denied handler renders
 * as a uniform RFC 7807 {@code 403}.
 */
@Configuration
@EnableMethodSecurity
public class MethodSecurityConfig {}
