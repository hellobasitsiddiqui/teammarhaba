package com.teammarhaba.backend.auth;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.teammarhaba.backend.web.Problems;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.web.access.AccessDeniedHandler;

/**
 * Returns a uniform JSON {@code 403} for authenticated-but-unauthorized requests (TM-111) — e.g. a
 * {@code USER} hitting an {@code @PreAuthorize("hasRole('ADMIN')")} endpoint — in the same RFC 7807
 * {@code application/problem+json} shape as every other error (via {@link Problems}). The 401
 * counterpart is {@link RestAuthenticationEntryPoint}; together they keep auth failures uniform.
 *
 * <p>Instantiated by {@link com.teammarhaba.backend.security.SecurityConfig} (not a component scan)
 * so the security chain stays self-contained wherever it's imported, including test slices.
 */
public class RestAccessDeniedHandler implements AccessDeniedHandler {

    private final ObjectMapper objectMapper;

    public RestAccessDeniedHandler(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public void handle(
            HttpServletRequest request, HttpServletResponse response, AccessDeniedException accessDeniedException)
            throws IOException {

        ProblemDetail problem = Problems.forbidden("You do not have permission to access this resource.");

        response.setStatus(HttpStatus.FORBIDDEN.value());
        response.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        objectMapper.writeValue(response.getWriter(), problem);
    }
}
