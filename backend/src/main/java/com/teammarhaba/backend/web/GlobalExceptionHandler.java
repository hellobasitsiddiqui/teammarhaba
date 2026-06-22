package com.teammarhaba.backend.web;

import com.teammarhaba.backend.common.InvalidListQueryException;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
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
 * <p>The list conventions (TM-115) guard sorting at the source:
 * {@link com.teammarhaba.backend.common.PageRequests} allow-lists sort properties and raises
 * {@link InvalidListQueryException} (→ 400 below), so a bad {@code sort} never reaches Spring Data
 * as a {@code PropertyReferenceException}.
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
