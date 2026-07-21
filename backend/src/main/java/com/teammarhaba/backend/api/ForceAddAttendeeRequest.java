package com.teammarhaba.backend.api;

import jakarta.validation.constraints.NotNull;

/**
 * The body of {@code POST /api/v1/admin/events/{id}/attendees} (TM-592) — an admin force-adding a
 * specific existing user as {@code GOING}.
 *
 * <p>{@code userId} is required (the target's {@code users.id}; must be an existing account, else a
 * {@code 404}). {@code override} (default {@code false}) is the explicit, audited bypass of the
 * capacity + age/eligibility + one-active-GOING guards — an admin knowingly forcing an over-cap /
 * out-of-band / double-booked add. The bypass is recorded on the audit row.
 *
 * @param userId   the {@code users.id} of the existing user to add as GOING (required)
 * @param override bypass capacity + age + one-active-GOING when {@code true} (audited); default {@code false}
 */
public record ForceAddAttendeeRequest(@NotNull Long userId, boolean override) {}
