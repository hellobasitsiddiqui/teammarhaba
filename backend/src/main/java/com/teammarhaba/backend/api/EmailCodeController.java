package com.teammarhaba.backend.api;

import com.google.firebase.auth.FirebaseAuthException;
import com.teammarhaba.backend.auth.EmailCodeService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Passwordless email-code login (TM-234), under {@code /api/v1/auth/email-code} (the {@code /api/v1}
 * prefix is applied by {@link ApiV1Config}). Both routes are <strong>unauthenticated</strong> — this
 * is how a user obtains a session — so they are permit-listed in {@code SecurityConfig} and protected
 * instead by server-side validation and rate-limiting in {@link EmailCodeService}.
 *
 * <ul>
 *   <li>{@code POST .../request} — generate + email a one-time code for an address. Always {@code 204}
 *       on a non-rate-limited call, regardless of whether the address has an account, so the endpoint
 *       can't enumerate users; a too-soon repeat is {@code 429} (the send cooldown).</li>
 *   <li>{@code POST .../verify} — check the code and, on success, return a Firebase custom token the
 *       client exchanges via {@code signInWithCustomToken}. A wrong/expired/exhausted code maps to the
 *       RFC 7807 status the {@code GlobalExceptionHandler} assigns each {@code EmailCodeException}
 *       reason.</li>
 * </ul>
 *
 * <p>This is purely additive: ID-token verification (TM-79) and the existing email+password sign-in
 * are untouched; email-code is just another front door onto the same Firebase session.
 */
@RestController
@RequestMapping("/auth/email-code")
public class EmailCodeController {

    private final EmailCodeService emailCodeService;

    EmailCodeController(EmailCodeService emailCodeService) {
        this.emailCodeService = emailCodeService;
    }

    /**
     * Request a login code for the given address. Returns {@code 204 No Content} — there is nothing to
     * return and no body that could leak whether the address exists. A second request inside the send
     * cooldown is refused with {@code 429} (the "Resend" UI uses this to back off).
     */
    @PostMapping("/request")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void request(@RequestBody @Valid EmailCodeRequest body) {
        emailCodeService.request(body.email());
    }

    /**
     * Verify a code and mint a Firebase custom token for the address's account (created on first
     * sight, matching Firebase passwordless). Returns {@code 200} with the token on success.
     *
     * @throws FirebaseAuthException if the Admin SDK call fails (mapped to {@code 502} in the advice)
     */
    @PostMapping("/verify")
    EmailCodeVerifyResponse verify(@RequestBody @Valid EmailCodeVerifyRequest body) throws FirebaseAuthException {
        return new EmailCodeVerifyResponse(emailCodeService.verify(body.email(), body.code()));
    }
}
