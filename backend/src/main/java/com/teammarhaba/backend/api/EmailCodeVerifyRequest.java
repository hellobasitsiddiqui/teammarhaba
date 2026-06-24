package com.teammarhaba.backend.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code POST /api/v1/auth/email-code/verify} (TM-234): the address plus the code the user
 * received. Unauthenticated — the (verified) code is what authenticates the caller. The code shape is
 * loosely validated here (4–10 digits) so an obviously-malformed value is a clean {@code 400}; the
 * authoritative single-use/expiry/attempt checks live in the service.
 *
 * @param email the address the code was requested for
 * @param code the numeric one-time code received by email
 */
public record EmailCodeVerifyRequest(
        @NotBlank @Size(max = 254) String email, @NotBlank @Pattern(regexp = "\\d{4,10}") String code) {}
