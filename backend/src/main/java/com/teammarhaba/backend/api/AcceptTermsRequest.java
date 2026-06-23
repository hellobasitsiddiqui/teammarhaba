package com.teammarhaba.backend.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Body for {@code POST /api/v1/me/accept-terms} (TM-163). The caller states which terms
 * {@code version} they are accepting; the server records it alongside {@code now()} as the
 * acceptance timestamp. Identity comes from the verified token, never the client.
 *
 * @param version the terms version being accepted, e.g. {@code "2026-06-01"}; required and non-blank
 */
public record AcceptTermsRequest(@NotBlank @Size(max = 64) String version) {}
