package com.teammarhaba.backend.api;

import jakarta.validation.constraints.Min;

/**
 * The body of {@code POST /api/v1/admin/events/{id}/capacity} (TM-592) — a first-class capacity
 * increase/decrease, distinct from the full edit form so the roster console can adjust the cap in one
 * click and surface the over-capacity warning.
 *
 * <p>{@code capacity} is {@code null} to make the event <em>unlimited</em> (removes the cap); any value
 * below 1 (0 or negative) is a Bean-Validation {@code 400} (TM-964 — the service also rejects it as a
 * backstop), so capacity can never be adjusted to 0, matching the create/edit form's {@code @Min(1)}.
 * Lowering below the current GOING count is allowed and never bumps a confirmed attendee — the event
 * simply sits over-cap (owner decision, surfaced in the response).
 *
 * @param capacity the new capacity ({@code null} = unlimited, else the max GOING count, ≥ 1)
 */
public record AdjustCapacityRequest(@Min(1) Integer capacity) {}
