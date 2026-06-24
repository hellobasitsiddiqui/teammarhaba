package com.teammarhaba.backend.api;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code POST /api/v1/auth/email-code/request} (TM-234): the address to email a one-time
 * login code to. This is an <strong>unauthenticated</strong> endpoint (it's how you sign in), so the
 * email is taken from the body, validated, and rate-limited server-side. The response never reveals
 * whether the address has an account.
 *
 * @param email the address to send the login code to; required and syntactically valid
 */
public record EmailCodeRequest(@NotBlank @Email @Size(max = 254) String email) {}
