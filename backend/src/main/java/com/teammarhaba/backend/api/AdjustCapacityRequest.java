package com.teammarhaba.backend.api;

import jakarta.validation.constraints.Min;

/**
 * The body of {@code POST /api/v1/admin/events/{id}/capacity} (TM-592) — a first-class capacity
 * increase/decrease, distinct from the full edit form so the roster console can adjust the cap in one
 * click and surface the over-capacity warning.
 *
 * <p>{@code capacity} is {@code null} to make the event <em>unlimited</em> (removes the cap); {@code 0}
 * is a legitimate "no more spots"; a negative value is a Bean-Validation {@code 400} (the service also
 * rejects it as a backstop). Lowering below the current GOING count is allowed and never bumps a
 * confirmed attendee — the event simply sits over-cap (owner decision, surfaced in the response).
 *
 * @param capacity the new capacity ({@code null} = unlimited, {@code 0} = closed, else the max GOING count)
 */
public record AdjustCapacityRequest(@Min(0) Integer capacity) {}
