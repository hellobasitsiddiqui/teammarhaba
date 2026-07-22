package com.teammarhaba.backend.web;

import java.net.URI;
import java.time.Instant;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;

/**
 * Factory for RFC 7807 {@link ProblemDetail} responses with a consistent shape
 * (stable {@code type} URI, {@code title}, {@code status}, {@code detail}, and a
 * {@code timestamp}). Centralised so every error — and the auth entry point that
 * lands in TM-79 (1.6.10) — produces the same contract.
 */
public final class Problems {

    /** Base URI for problem {@code type} links (need not resolve to a live page). */
    public static final URI TYPE_BASE = URI.create("https://teammarhaba.app/problems/");

    private Problems() {}

    /** Build a ProblemDetail for the given status with a human-readable title + detail. */
    public static ProblemDetail of(HttpStatus status, String title, String detail) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(status, detail);
        problem.setTitle(title);
        problem.setType(TYPE_BASE.resolve(String.valueOf(status.value())));
        problem.setProperty("timestamp", Instant.now());
        return problem;
    }

    /**
     * Reusable {@code 401 Unauthorized} shape for the auth filter / entry point
     * (TM-79). Kept here so authentication failures match every other error.
     */
    public static ProblemDetail unauthorized(String detail) {
        return of(HttpStatus.UNAUTHORIZED, "Unauthorized", detail);
    }

    /**
     * Reusable {@code 403 Forbidden} shape for authenticated-but-unauthorized requests — e.g. a
     * {@code USER} hitting an {@code @PreAuthorize("hasRole('ADMIN')")} endpoint (TM-111). Returned
     * by the access-denied handler so authorization failures match every other error.
     */
    public static ProblemDetail forbidden(String detail) {
        return of(HttpStatus.FORBIDDEN, "Forbidden", detail);
    }

    /**
     * {@code 422 Unprocessable Entity} — the request is well-formed but violates a business rule
     * (e.g. an admin trying to disable or demote their own account, TM-111).
     */
    public static ProblemDetail unprocessable(String detail) {
        return of(HttpStatus.UNPROCESSABLE_ENTITY, "Operation not allowed", detail);
    }

    /**
     * {@code 422 Unprocessable Entity} for a locked-name rename (TM-907) — a well-formed request that
     * a business rule forbids, given a <em>distinct</em> {@code type} URI ({@code .../name-locked},
     * not the generic {@code .../422}) so the web can reliably detect this specific refusal (rather
     * than string-matching {@code detail}) and switch the name fields to read-only.
     */
    public static ProblemDetail nameLocked(String detail) {
        ProblemDetail problem = of(HttpStatus.UNPROCESSABLE_ENTITY, "Name is locked", detail);
        problem.setType(TYPE_BASE.resolve("name-locked"));
        return problem;
    }
}
