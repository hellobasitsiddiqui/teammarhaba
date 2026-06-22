package com.teammarhaba.backend.web;

import com.teammarhaba.backend.common.InvalidListQueryException;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.mapping.PropertyReferenceException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

/**
 * Global error model: every failure returns an RFC 7807 {@code application/problem+json}
 * body via {@link Problems}, so all clients (web/webview/android) handle errors uniformly
 * and no stack trace is ever leaked.
 *
 * <p>Extending {@link ResponseEntityExceptionHandler} means the framework's own MVC
 * exceptions (unreadable body, missing params, 404/405/415, …) also return ProblemDetail.
 *
 * <p>List-query safety (bad sort/filter -> 400, never 500): TM-115's
 * {@link com.teammarhaba.backend.common.PageRequests} allow-lists sort properties and raises
 * {@link InvalidListQueryException}; the admin user list (TM-111) adds a
 * {@code PropertyReferenceException -> 400} safety net. Both are mapped below.
 */
@RestControllerAdvice
public class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    /** Bean Validation failures on a {@code @Valid} request body -> 400 with field details. */
    @Override
    protected ResponseEntity<Object> handleMethodArgumentNotValid(
            MethodArgumentNotValidException ex,
            HttpHeaders headers,
            HttpStatusCode status,
            WebRequest request) {
        ProblemDetail problem =
                Problems.of(HttpStatus.BAD_REQUEST, "Validation failed", "One or more fields are invalid.");
        List<Map<String, String>> errors = ex.getBindingResult().getFieldErrors().stream()
                .map(fe -> Map.of("field", fe.getField(), "message", String.valueOf(fe.getDefaultMessage())))
                .toList();
        problem.setProperty("errors", errors);
        return ResponseEntity.badRequest().body(problem);
    }

    /** Missing/unknown resource -> 404. */
    @ExceptionHandler(ResourceNotFoundException.class)
    public ProblemDetail handleNotFound(ResourceNotFoundException ex) {
        return Problems.of(HttpStatus.NOT_FOUND, "Resource not found", ex.getMessage());
    }

    /** Bad list query (e.g. an un-allow-listed {@code sort} property) -> 400. */
    @ExceptionHandler(InvalidListQueryException.class)
    public ProblemDetail handleInvalidListQuery(InvalidListQueryException ex) {
        return Problems.of(HttpStatus.BAD_REQUEST, "Invalid request", ex.getMessage());
    }

    /** Malformed request not caught by Bean Validation (e.g. an unknown sort property, TM-111) -> 400. */
    @ExceptionHandler(BadRequestException.class)
    public ProblemDetail handleBadRequest(BadRequestException ex) {
        return Problems.of(HttpStatus.BAD_REQUEST, "Bad request", ex.getMessage());
    }

    /** A list endpoint asked to sort/filter by an unknown property -> 400 (the safety net for TM-111). */
    @ExceptionHandler(PropertyReferenceException.class)
    public ProblemDetail handleBadSortProperty(PropertyReferenceException ex) {
        return Problems.of(HttpStatus.BAD_REQUEST, "Bad request", "Unknown sort or filter property.");
    }

    /** A self-protected admin action on one's own account (disable/demote, TM-111) -> 422. */
    @ExceptionHandler(SelfActionNotAllowedException.class)
    public ProblemDetail handleSelfAction(SelfActionNotAllowedException ex) {
        return Problems.unprocessable(ex.getMessage());
    }

    /**
     * Authenticated-but-unauthorized — a {@code @PreAuthorize} denial (e.g. {@code USER} on an
     * admin route, TM-111) -> 403. Method-security throws this <em>during</em> controller dispatch,
     * so it surfaces here in the advice (not at the security-chain access-denied handler); mapping it
     * explicitly keeps it a uniform 403 instead of being swallowed as a 500 by the catch-all below.
     */
    @ExceptionHandler(AccessDeniedException.class)
    public ProblemDetail handleAccessDenied(AccessDeniedException ex) {
        return Problems.forbidden("You do not have permission to access this resource.");
    }

    /** DB / state conflict (e.g. unique-constraint violation) -> 409. */
    @ExceptionHandler(DataIntegrityViolationException.class)
    public ProblemDetail handleConflict(DataIntegrityViolationException ex) {
        log.warn("Data integrity violation", ex);
        return Problems.of(
                HttpStatus.CONFLICT,
                "Conflict",
                "The request conflicts with the current state of the resource.");
    }

    /** Optimistic-lock conflict: someone else updated the row first (stale {@code @Version}) -> 409. */
    @ExceptionHandler(ObjectOptimisticLockingFailureException.class)
    public ProblemDetail handleOptimisticLock(ObjectOptimisticLockingFailureException ex) {
        log.warn("Optimistic lock conflict", ex);
        return Problems.of(
                HttpStatus.CONFLICT,
                "Conflict",
                "The resource was changed by another request. Reload the latest version and try again.");
    }

    /** Anything unmapped -> generic 500. The real cause is logged, never returned. */
    @ExceptionHandler(Exception.class)
    public ProblemDetail handleUnexpected(Exception ex) {
        log.error("Unhandled exception", ex);
        return Problems.of(
                HttpStatus.INTERNAL_SERVER_ERROR, "Internal server error", "An unexpected error occurred.");
    }
}
