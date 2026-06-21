package com.teammarhaba.backend.auth;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseToken;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpHeaders;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.util.StringUtils;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Verifies the caller's Firebase ID token on each request (TM-79). Reads
 * {@code Authorization: Bearer <token>}, verifies it with the Firebase Admin SDK, and — on
 * success — establishes the Spring Security context with a {@link VerifiedUser} principal
 * (uid + email). It never sends a {@code 401} itself: on a missing/invalid token it simply
 * leaves the request unauthenticated, so the security chain's {@link RestAuthenticationEntryPoint}
 * produces one uniform 401 for every protected route (default-deny).
 *
 * <p>{@link FirebaseAuth} is resolved lazily via an {@link ObjectProvider} so it is only
 * initialised when a token is actually present — keeping token-free requests (and the whole
 * dev/test/CI boot, which has no credentials) free of any Firebase initialisation.
 */
public class FirebaseAuthenticationFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(FirebaseAuthenticationFilter.class);
    private static final String BEARER_PREFIX = "Bearer ";

    private final ObjectProvider<FirebaseAuth> firebaseAuth;

    public FirebaseAuthenticationFilter(ObjectProvider<FirebaseAuth> firebaseAuth) {
        this.firebaseAuth = firebaseAuth;
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {

        String token = bearerToken(request);
        if (token != null && SecurityContextHolder.getContext().getAuthentication() == null) {
            try {
                FirebaseToken decoded = firebaseAuth.getObject().verifyIdToken(token);
                VerifiedUser user = new VerifiedUser(decoded.getUid(), decoded.getEmail());
                var authentication =
                        new UsernamePasswordAuthenticationToken(user, null, List.of());
                authentication.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
                SecurityContextHolder.getContext().setAuthentication(authentication);
            } catch (Exception e) {
                // Invalid/expired token (or no Firebase credentials): leave unauthenticated so
                // the entry point returns a uniform 401. Never log the token itself.
                SecurityContextHolder.clearContext();
                log.debug("Firebase ID token verification failed: {}", e.getMessage());
            }
        }
        chain.doFilter(request, response);
    }

    private String bearerToken(HttpServletRequest request) {
        String header = request.getHeader(HttpHeaders.AUTHORIZATION);
        if (StringUtils.hasText(header) && header.startsWith(BEARER_PREFIX)) {
            String token = header.substring(BEARER_PREFIX.length()).trim();
            return token.isEmpty() ? null : token;
        }
        return null;
    }
}
