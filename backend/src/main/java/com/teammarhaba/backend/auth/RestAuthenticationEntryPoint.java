package com.teammarhaba.backend.auth;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.teammarhaba.backend.web.Problems;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;

/**
 * Returns a uniform JSON {@code 401} for unauthenticated requests to protected routes (TM-79),
 * in the same RFC 7807 {@code application/problem+json} shape as every other error (via
 * {@link Problems}, the TM-72 error model) — so clients handle auth failures like any other.
 * A stack trace or token value is never leaked.
 *
 * <p>Instantiated by {@link com.teammarhaba.backend.security.SecurityConfig} (not a component
 * scan) so the security chain stays self-contained wherever it's imported, including test slices.
 */
public class RestAuthenticationEntryPoint implements AuthenticationEntryPoint {

    private final ObjectMapper objectMapper;

    public RestAuthenticationEntryPoint(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public void commence(
            HttpServletRequest request, HttpServletResponse response, AuthenticationException authException)
            throws IOException {

        ProblemDetail problem =
                Problems.unauthorized("A valid Firebase ID token is required to access this resource.");

        response.setStatus(HttpStatus.UNAUTHORIZED.value());
        response.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        objectMapper.writeValue(response.getWriter(), problem);
    }
}
